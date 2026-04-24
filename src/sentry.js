// src/sentry.js — lightweight Clint-side Sentry integration.
//
// Uses Sentry's native envelope-ingest API via fetch — no SDK
// dependency. That's a deliberate trade: we lose auto-capture of
// uncaught exceptions, breadcrumbs, and session tracking, but we gain
// zero-dependency shipping and full control over when events fire.
//
// What this module provides:
//   - captureException(err, context): manual error capture with tags
//   - captureMessage(message, level, context): info-level events
//   - newTraceContext(): generates a sentry-trace header pair so
//     outbound requests to bot-council can be linked to Clint-side
//     activity in Sentry's distributed-trace view
//   - withTrace(fn): wraps an async fn so its errors attach to a trace
//   - No-op fallback: when SENTRY_DSN is unset, every export becomes a
//     cheap no-op. Safe to call from any hot path.
//
// Future expansion (deferred): full @sentry/node install for auto-
// capture, breadcrumbs, span instrumentation, session replay. This
// module is the minimum-value floor — when the DSN lands, Clint starts
// reporting immediately; when we want more, we layer the SDK on top.

import { randomBytes } from 'node:crypto';
import logger from './logger.js';

// ── DSN parsing ─────────────────────────────────────────────────────

/**
 * Parse a Sentry DSN into its ingest components. DSN format:
 *   https://<publicKey>@<host>/<projectId>
 * We POST events to https://<host>/api/<projectId>/envelope/ with
 * X-Sentry-Auth header.
 */
export function parseDsn(dsn) {
  if (!dsn || typeof dsn !== 'string') return null;
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    if (!publicKey || !projectId) return null;
    return {
      publicKey,
      host: u.host,
      projectId,
      ingestUrl: `${u.protocol}//${u.host}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

// ── Module state ────────────────────────────────────────────────────

let config = null;     // { dsn, environment, release, user? }
let dsn = null;        // parsed DSN components or null
let enabled = false;

export function initSentry(opts = {}) {
  const rawDsn = opts.dsn || process.env.SENTRY_DSN || '';
  const parsed = parseDsn(rawDsn);
  if (!parsed) {
    enabled = false;
    config = null;
    dsn = null;
    logger.info('sentry: disabled (SENTRY_DSN unset or unparseable)');
    return false;
  }
  dsn = parsed;
  config = {
    environment: opts.environment || process.env.SENTRY_ENVIRONMENT || 'production',
    release: opts.release || process.env.SENTRY_RELEASE || null,
    serverName: opts.serverName || 'clawdbot',
  };
  enabled = true;
  logger.info({ host: parsed.host, project: parsed.projectId, env: config.environment }, 'sentry: enabled');
  // Wire Node.js process-level error handlers so uncaught errors in
  // background tasks still surface. We don't replace existing handlers;
  // we add listeners that capture-and-continue.
  process.on('uncaughtException', (err) => {
    captureException(err, { tags: { handler: 'uncaughtException' } }).catch(() => {});
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureException(err, { tags: { handler: 'unhandledRejection' } }).catch(() => {});
  });
  return true;
}

export function isSentryEnabled() {
  return enabled;
}

// ── Trace ID utilities ──────────────────────────────────────────────
// Sentry's distributed-trace header is W3C-inspired:
//   sentry-trace: <trace_id>-<span_id>-<sampled>
// plus a baggage header carrying the trace origin. Generating these
// on outbound bot-council calls lets us stitch Clint's trace to any
// error bot-council's own SDK reports under the same trace_id.

function randomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

export function newTraceContext() {
  const traceId = randomHex(16);      // 32 hex chars
  const spanId = randomHex(8);        // 16 hex chars
  return {
    traceId,
    spanId,
    sentryTrace: `${traceId}-${spanId}-1`,
    baggage: `sentry-environment=${config?.environment || 'production'},sentry-trace_id=${traceId}`,
  };
}

/**
 * Inject sentry-trace + baggage into an outbound fetch headers object.
 * No-op when Sentry is disabled so hot paths that use this wrapper
 * don't need to branch on `enabled`.
 */
export function injectTraceHeaders(headers = {}, traceCtx = null) {
  if (!enabled) return headers;
  const ctx = traceCtx || newTraceContext();
  return {
    ...headers,
    'sentry-trace': ctx.sentryTrace,
    baggage: ctx.baggage,
  };
}

// ── Event sending ───────────────────────────────────────────────────

function nowIsoUtc() {
  return new Date().toISOString();
}

async function sendEnvelope(event) {
  if (!enabled || !dsn) return false;
  const eventId = randomHex(16);
  const sentAt = nowIsoUtc();
  const auth = `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=clint/1.0`;
  const envelopeHeader = JSON.stringify({ event_id: eventId, sent_at: sentAt });
  const itemHeader = JSON.stringify({ type: 'event', content_type: 'application/json' });
  const itemPayload = JSON.stringify({ ...event, event_id: eventId, timestamp: sentAt });
  const body = `${envelopeHeader}\n${itemHeader}\n${itemPayload}`;
  try {
    await fetch(dsn.ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': auth,
      },
      body,
    });
    return true;
  } catch (err) {
    // Don't throw — Sentry delivery failure must not cascade into a
    // cascade of captureException retries. Log at warn and drop.
    logger.warn({ err: err.message }, 'sentry: envelope send failed');
    return false;
  }
}

/**
 * Report an error to Sentry. On disabled/unset, immediate no-op.
 *
 * @param {Error|string} err — the error to capture
 * @param {object} [context]
 * @param {object} [context.tags]   — string→string dictionary
 * @param {object} [context.extra]  — arbitrary JSON-serializable context
 * @param {object} [context.user]   — {id, ...} override per-call
 * @param {string} [context.level]  — error|warning|info|debug|fatal
 */
export async function captureException(err, context = {}) {
  if (!enabled) return false;
  const error = err instanceof Error ? err : new Error(String(err));
  const event = {
    platform: 'node',
    environment: config.environment,
    release: config.release || undefined,
    server_name: config.serverName,
    level: context.level || 'error',
    exception: {
      values: [{
        type: error.name || 'Error',
        value: error.message || String(error),
        stacktrace: error.stack
          ? { frames: parseStackFrames(error.stack) }
          : undefined,
      }],
    },
    tags: context.tags || {},
    extra: context.extra || {},
    user: context.user || config.user || undefined,
    contexts: context.trace ? { trace: context.trace } : undefined,
  };
  return sendEnvelope(event);
}

export async function captureMessage(message, level = 'info', context = {}) {
  if (!enabled) return false;
  const event = {
    platform: 'node',
    environment: config.environment,
    release: config.release || undefined,
    server_name: config.serverName,
    level,
    message: { formatted: message },
    tags: context.tags || {},
    extra: context.extra || {},
    user: context.user || config.user || undefined,
  };
  return sendEnvelope(event);
}

/**
 * Set the user context for subsequent captures. Called after WhatsApp
 * pairs up so every Clint error is attributable to James.
 */
export function setUser(user) {
  if (!config) return;
  config.user = user || undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseStackFrames(stack) {
  // Minimal stack-frame parser. Sentry accepts a richer format, but
  // the node-default "at func (file:line:col)" lines round-trip well.
  const frames = [];
  const lines = stack.split('\n').slice(1); // drop the error message line
  for (const line of lines) {
    const m = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ||
              line.match(/at\s+()(.+?):(\d+):(\d+)/);
    if (!m) continue;
    frames.push({
      function: m[1] || '<anonymous>',
      filename: m[2],
      lineno: parseInt(m[3], 10),
      colno: parseInt(m[4], 10),
      in_app: !m[2].includes('node_modules'),
    });
  }
  // Sentry displays frames newest-last
  return frames.reverse();
}

// Exposed for tests so they don't clobber module state between cases.
export function resetSentryForTests() {
  config = null;
  dsn = null;
  enabled = false;
}
