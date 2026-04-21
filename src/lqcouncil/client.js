// src/lqcouncil/client.js — thin HTTP wrapper around the Bot Council API.
//
// Clint co-runs with bot-council on EVO, so the default base URL is the
// loopback address (skips the Cloudflare Tunnel). Reads LQC_API_URL,
// LQC_ADMIN_TOKEN, LQC_ENABLED from config. All methods resolve with
// parsed JSON or reject with a short error string suitable for
// surfacing in WhatsApp.
//
// Timeout is 10s per request; no retries (user-initiated — surface
// failures fast instead of hiding them).
//
// Path contract: bot-council mounts every JSON route under `/api/*` in
// production (same-origin with the SvelteKit frontend). `baseUrl()`
// appends `/api` so callers pass un-prefixed paths like `/debates`,
// `/bots`, `/diag/models`. LQC_API_URL may be either `http://host:port`
// or `http://host:port/api`; both are normalised to the latter.

import config from '../config.js';
import logger from '../logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Return true when the integration is configured end-to-end. */
export function isEnabled() {
  return config.lqcEnabled && !!config.lqcApiUrl && !!config.lqcAdminToken;
}

/**
 * Normalise any LQC_API_URL-shaped input to `<origin>/api`. Accepts
 * `http://host:port`, `http://host:port/`, `http://host:port/api`, and
 * `http://host:port/api/` — all produce `http://host:port/api`.
 *
 * Exported as a pure function so tests can exercise every shape without
 * fighting with the config singleton.
 */
export function normaliseApiBase(input) {
  const raw = (input && typeof input === 'string' ? input : '').trim() || 'http://127.0.0.1:3100';
  const origin = raw
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
  return origin + '/api';
}

/**
 * Base URL including the `/api` prefix. Thin wrapper over
 * `normaliseApiBase` that reads the live config.
 */
export function baseUrl() {
  return normaliseApiBase(config.lqcApiUrl);
}

/** Common request helper. Throws on non-2xx with a human-readable message. */
async function request(method, path, { body = null, query = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isEnabled()) {
    throw new Error('LQ Council integration is disabled (LQC_ENABLED=false or missing LQC_API_URL/LQC_ADMIN_TOKEN)');
  }

  // Compose via string concatenation, NOT `new URL(path, base)`. The
  // two-arg URL constructor treats an absolute `path` (leading `/`) as
  // origin-relative — it would silently discard the `/api` prefix baked
  // into `baseUrl()`. That was the original bug this module was written
  // to fix; do not reintroduce it.
  const pathWithLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(baseUrl() + pathWithLeadingSlash);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'accept': 'application/json',
      'authorization': `Bearer ${config.lqcAdminToken}`,
    };
    const init = { method, headers, signal: controller.signal };
    if (body !== null && body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const resp = await fetch(url.toString(), init);
    const text = await resp.text();
    const payload = text.length > 0 ? safeParseJson(text) : null;
    if (!resp.ok) {
      const detail = payload && typeof payload === 'object' && payload.error
        ? payload.error
        : text.slice(0, 200);
      logger.warn({ method, path, status: resp.status, detail }, 'LQC request failed');
      throw new Error(`LQC ${method} ${path}: HTTP ${resp.status} ${detail || ''}`.trim());
    }
    return payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`LQC ${method} ${path}: request timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJson(text) {
  try { return JSON.parse(text); }
  catch { return text; }
}

// ── Reads ─────────────────────────────────────────────────────────────

export async function getDiagHealth() {
  return request('GET', '/diag/health');
}

/**
 * Public runtime config served by bot-council to the SvelteKit bundle.
 * Returns `{publishable_key, sentry_environment, release, api_base}`;
 * `release` is the git SHA the backend was built from — useful in
 * `lqc_status` since `/api/diag/health` only returns `{status:"ok"}`.
 *
 * This endpoint does not require auth but `request()` attaches a Bearer
 * anyway; that's a no-op for config.json.
 */
export async function getPublicConfig() {
  return request('GET', '/config.json');
}

/**
 * Admin-only: effective model routing for analyser + final-synthesis.
 * Returns `{analysis_base_url, analysis_model, final_synthesis_base_url,
 * final_synthesis_model, …}`. Answers "is Clint still on MiniMax, or has
 * it fallen back to the local llama-server?".
 */
export async function getModelsDiag() {
  return request('GET', '/diag/models');
}

export async function listDebates({ limit = 20, status = null } = {}) {
  return request('GET', '/debates', { query: { limit, status } });
}

export async function getDebate(debateId) {
  return request('GET', `/debates/${encodeURIComponent(debateId)}`);
}

export async function getTranscript(debateId) {
  return request('GET', `/debates/${encodeURIComponent(debateId)}/transcript`);
}

export async function getSynthesis(debateId) {
  return request('GET', `/debates/${encodeURIComponent(debateId)}/synthesis`);
}

// ── Writes ────────────────────────────────────────────────────────────

/**
 * Start a new debate. POST /debates accepts at minimum `{topic}` — the
 * server picks defaults for bot selection, rounds, etc. Pass `bot_ids`
 * to constrain participants. Returns the server-allocated debate id in
 * the response body.
 *
 * The orchestrator kicks off round 0 synchronously on submit (our
 * probes saw the request block for ~10s). Caller should expect
 * request-level latency proportional to the first-round bot calls.
 */
export async function createDebate({ topic, bot_ids = null } = {}) {
  const body = { topic };
  if (Array.isArray(bot_ids) && bot_ids.length > 0) body.bot_ids = bot_ids;
  return request('POST', '/debates', { body, timeoutMs: 60_000 });
}

export async function listBots() {
  return request('GET', '/bots');
}

export async function getBotSchema() {
  return request('GET', '/bots/schema');
}

export async function getBotHistory(botId, { limit = 20 } = {}) {
  return request('GET', `/bots/${encodeURIComponent(botId)}/history`, { query: { limit } });
}

export async function listAdmins() {
  return request('GET', '/admins');
}

export async function listUsers() {
  return request('GET', '/users');
}

// ── Validation (read-only, but uses POST) ─────────────────────────────

export async function validateBot({ endpoint_url, token }) {
  return request('POST', '/bots/validate', {
    body: { endpoint_url, token },
    timeoutMs: 45_000, // validate runs a live smoke test against the URL
  });
}

// ── Admin writes (Phase D) ─────────────────────────────────────────────

/**
 * Soft-archive or un-archive a debate. Sets/clears `archived_at` on the
 * debates row. Archived debates are hidden from the default list but
 * surface via `?archived=true`. Reversible.
 */
export async function archiveDebate(debateId, archived) {
  return request('PATCH', `/debates/${encodeURIComponent(debateId)}/archive`, {
    body: { archived: !!archived },
  });
}

/**
 * Permanently delete a debate, cascading through responses, analyses,
 * syntheses, debate_bots, and dropping the broadcast channel. NOT
 * REVERSIBLE. Caller must obtain explicit confirmation before invoking.
 */
export async function deleteDebate(debateId) {
  return request('DELETE', `/debates/${encodeURIComponent(debateId)}`);
}
