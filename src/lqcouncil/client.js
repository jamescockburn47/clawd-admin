// src/lqcouncil/client.js — thin HTTP wrapper around the Bot Council API.
//
// Clint co-runs with bot-council on EVO, so the default base URL is the
// loopback address that skips Vercel proxy + Tailscale Funnel. Reads
// LQC_API_URL, LQC_ADMIN_TOKEN, LQC_ENABLED from config. All methods
// resolve with parsed JSON or reject with a short error string suitable
// for surfacing in WhatsApp.
//
// Timeout is 10s per request; no retries (user-initiated — surface
// failures fast instead of hiding them).

import config from '../config.js';
import logger from '../logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Return true when the integration is configured end-to-end. */
export function isEnabled() {
  return config.lqcEnabled && !!config.lqcApiUrl && !!config.lqcAdminToken;
}

/** Base URL without trailing slash. */
function baseUrl() {
  return (config.lqcApiUrl || 'http://127.0.0.1:3100').replace(/\/+$/, '');
}

/** Common request helper. Throws on non-2xx with a human-readable message. */
async function request(method, path, { body = null, query = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isEnabled()) {
    throw new Error('LQ Council integration is disabled (LQC_ENABLED=false or missing LQC_API_URL/LQC_ADMIN_TOKEN)');
  }

  const url = new URL(path, baseUrl() + '/');
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
