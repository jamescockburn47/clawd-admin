// src/lqcouncil/sentry-webhook.js — handler for POST /api/sentry-webhook.
//
// Sentry "issue alert" webhooks fire on new issues in bot-council projects.
// This handler verifies the HMAC signature, formats a WhatsApp-friendly
// message with issue tags (debate_id, bot_id — populated by Phase 0 Sentry
// enrichment), and routes it to the LQcouncil-bound group so bot authors
// see errors affecting their bots without polling.
//
// Dedupe: issues older than DEDUPE_WINDOW_MS since lastSeen are ignored so
// a re-fired webhook on a known issue does not spam the channel.

import { createHmac, timingSafeEqual } from 'node:crypto';
import logger from '../logger.js';
// `config` and `group-registry` are imported lazily inside the handler so
// the pure verification/formatting helpers below can be unit-tested without
// booting Zod config (which requires ANTHROPIC_API_KEY, not present in CI).

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_TITLE_CHARS = 200;
const MAX_CULPRIT_CHARS = 160;

/**
 * Timing-safe HMAC-SHA256 verification against Sentry's
 * `sentry-hook-signature` header. Returns true if valid, false otherwise.
 * Returns false when the secret is unset (fail-closed).
 */
export function verifySentrySignature(rawBody, signature, secret) {
  if (!secret) return false;
  if (!signature || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

function truncate(str, max) {
  if (!str || typeof str !== 'string') return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

/**
 * Format a Sentry issue-alert payload into a WA-ready block. Returns null
 * if the payload is stale (outside DEDUPE_WINDOW_MS) or malformed.
 */
export function formatSentryAlert(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data || {};
  const issue = data.issue || data.event || null;
  if (!issue || typeof issue !== 'object') return null;

  const title = truncate(issue.title || issue.message || '(untitled issue)', MAX_TITLE_CHARS);
  const culprit = truncate(issue.culprit || issue.location || '', MAX_CULPRIT_CHARS);
  const project = issue.project || payload.project || 'unknown-project';
  const level = issue.level || 'error';
  const lastSeenIso = issue.lastSeen || issue.last_seen || null;
  const url = issue.web_url || issue.url || null;
  const tags = Array.isArray(issue.tags) ? issue.tags : [];
  const tagMap = {};
  for (const t of tags) {
    if (Array.isArray(t) && t.length >= 2) tagMap[String(t[0])] = String(t[1]);
    else if (t && typeof t === 'object' && 'key' in t && 'value' in t) tagMap[String(t.key)] = String(t.value);
  }
  const release = tagMap.release || issue.release || null;

  if (lastSeenIso) {
    const lastSeenMs = Date.parse(lastSeenIso);
    if (Number.isFinite(lastSeenMs) && now - lastSeenMs > DEDUPE_WINDOW_MS) {
      return null;
    }
  }

  const lines = [`*LQ Council Sentry: ${level}*`, title];
  if (culprit) lines.push(`at \`${culprit}\``);
  lines.push('');
  if (tagMap.debate_id) lines.push(`debate: ${tagMap.debate_id}`);
  if (tagMap.bot_id) lines.push(`bot: ${tagMap.bot_id}`);
  if (tagMap.error_kind) lines.push(`kind: ${tagMap.error_kind}`);
  if (release) lines.push(`release: ${release}`);
  lines.push(`project: ${project}`);
  if (url) lines.push(`→ ${url}`);
  if (tagMap.debate_id) lines.push(`\nUse \`lqc_why_failed ${tagMap.debate_id}\` for correlation.`);
  return lines.join('\n');
}

/**
 * Wire into the existing http-server. Reads the raw body string, verifies
 * the HMAC, formats the alert, sends it via the injected sendProactiveMessage.
 * Returns { status, body } for the caller to write back to the HTTP response.
 */
export async function handleSentryWebhookRequest({ rawBody, signature, headers = {}, sendProactiveMessage }) {
  const [{ default: config }, { findGroupJidByProject }] = await Promise.all([
    import('../config.js'),
    import('../group-registry.js'),
  ]);
  const secret = config.lqcSentryWebhookSecret || '';
  if (!secret) {
    logger.warn({
      sigPresent: !!signature,
      bodyLen: rawBody ? rawBody.length : 0,
      resource: headers['sentry-hook-resource'] || headers['Sentry-Hook-Resource'] || null,
    }, 'sentry-webhook: dropped (no LQC_SENTRY_WEBHOOK_SECRET)');
    return { status: 503, body: { error: 'webhook disabled: LQC_SENTRY_WEBHOOK_SECRET unset' } };
  }
  if (!verifySentrySignature(rawBody, signature, secret)) {
    // Enriched diagnostic — the older `sigPresent:false` line left us
    // guessing whether Sentry sent the wrong secret, the wrong header
    // name, or an unsigned probe. Log everything Sentry shipped short
    // of the body (which may contain sensitive data) + the hash of
    // what we'd have expected, so a mismatch is diagnosable in one
    // look. The expected-hash prefix is safe to surface; it's not the
    // secret and an attacker with the raw body could compute it
    // themselves.
    let expectedPrefix = null;
    try {
      expectedPrefix = createHmac('sha256', secret).update(rawBody || '').digest('hex').slice(0, 12);
    } catch { /* intentional: diagnostic only */ }
    logger.warn({
      sigPresent: !!signature,
      sigLen: signature ? signature.length : 0,
      sigPrefix: signature ? String(signature).slice(0, 12) : null,
      expectedPrefix,
      bodyLen: rawBody ? rawBody.length : 0,
      bodyPreview: rawBody ? String(rawBody).slice(0, 120) : null,
      resource: headers['sentry-hook-resource'] || headers['Sentry-Hook-Resource'] || null,
      hookId: headers['sentry-hook-id'] || headers['Sentry-Hook-Id'] || null,
      contentType: headers['content-type'] || headers['Content-Type'] || null,
    }, 'sentry-webhook: signature verification failed');
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }

  const message = formatSentryAlert(payload);
  if (!message) {
    // Dedupe or malformed payload — ack so Sentry does not retry.
    return { status: 202, body: { ok: true, skipped: 'stale or malformed' } };
  }

  const jid = findGroupJidByProject('lqcouncil') || (config.ownerJid || '').trim();
  // note: imports already resolved at the top of this function.
  if (!jid) {
    logger.warn({ preview: message.slice(0, 100) }, 'sentry-webhook: no destination resolved');
    return { status: 202, body: { ok: true, skipped: 'no destination' } };
  }
  if (typeof sendProactiveMessage !== 'function') {
    logger.warn('sentry-webhook: sendProactiveMessage not injected');
    return { status: 500, body: { error: 'proactive sender not available' } };
  }
  try {
    await sendProactiveMessage(jid, message);
    return { status: 202, body: { ok: true, delivered: true } };
  } catch (err) {
    logger.error({ err: err.message }, 'sentry-webhook: delivery failed');
    return { status: 500, body: { error: 'delivery failed' } };
  }
}
