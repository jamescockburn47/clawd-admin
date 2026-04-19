// src/tasks/lqc-monitor.js — 60-second tick that surfaces LQ Bot
// Council signal into WhatsApp.
//
// Phase 4 scope (minimal/safe):
//   - Detect newly-failed debates since the last tick; post one alert
//     per debate to LQC_DEV_GROUP_JID.
//   - Detect health thresholds (failure_rate_1h crossings, stuck debates)
//     with edge-triggered alerts and per-signal cooldowns.
//   - Detect new error_kinds on active bots via /bots/{id}/history
//     aggregation so authors get notified before asking Clint.
//
// Explicitly deferred:
//   - SSE subscriber (needs http-server.js work — user has WIP there).
//   - Sentry webhook route (same blocker).
//
// State is in-memory (Map). On service restart we re-seed from the
// current state so an already-failed debate isn't re-announced.

import * as lqc from '../lqcouncil/client.js';
import config from '../config.js';
import { findGroupJidByProject } from '../group-registry.js';
import logger from '../logger.js';

// ── State ────────────────────────────────────────────────────────────

/** debate_id → seen status (so transitions to 'failed' are edge-triggered) */
const debateStatusSeen = new Map();
/** bot_id → dominant error_kind last observed (fire nudge on new dominant kind) */
const botDominantErrorKind = new Map();
/** signal name → last-fired timestamp for cooldown (ms) */
const signalCooldowns = new Map();
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes per signal
const FAILURE_RATE_THRESHOLD = 0.25;
const STUCK_DEBATE_MINUTES = 30;

let _sendProactive = null;
let _seeded = false;

// ── Injection ───────────────────────────────────────────────────────

/** Called by index.js after the proactive-message helper is available. */
export function initLqcMonitor(sendProactiveMessage) {
  _sendProactive = sendProactiveMessage;
}

// ── Helpers ──────────────────────────────────────────────────────────

function canFire(signal) {
  const last = signalCooldowns.get(signal) || 0;
  return Date.now() - last >= COOLDOWN_MS;
}

function markFired(signal) {
  signalCooldowns.set(signal, Date.now());
}

/**
 * Resolve an alert destination by severity.
 *   - `ops`:    owner DM. Used for stuck debates, provider-health alerts,
 *               things that don't need to be visible to bot authors.
 *   - `author`: the LQcouncil-bound group (via allowedProjects lookup).
 *               Used for per-debate failure and per-bot pattern shifts —
 *               the authors benefit from seeing these.
 * Falls back to the legacy LQC_DEV_GROUP_JID env var for back-compat,
 * then to owner DM, to ensure alerts never silently drop.
 */
function resolveDestination(severity) {
  const legacy = (config.lqcDevGroupJid || '').trim();
  const ownerJid = (config.ownerJid || '').trim();
  if (severity === 'author') {
    const bound = findGroupJidByProject('lqcouncil');
    if (bound) return { jid: bound, source: 'allowedProjects' };
    if (legacy) return { jid: legacy, source: 'legacy_env' };
    if (ownerJid) return { jid: ownerJid, source: 'owner_fallback' };
    return null;
  }
  // severity === 'ops'
  if (ownerJid) return { jid: ownerJid, source: 'owner_dm' };
  if (legacy) return { jid: legacy, source: 'legacy_env' };
  return null;
}

async function send(text, severity = 'author') {
  const dest = resolveDestination(severity);
  if (!dest) {
    logger.info({ severity, preview: text.slice(0, 120) }, 'LQC monitor: no destination resolved — alert not sent');
    return;
  }
  if (!_sendProactive) {
    logger.warn('LQC monitor: sendProactiveMessage not initialised');
    return;
  }
  try {
    await _sendProactive(dest.jid, text);
    logger.info({ severity, jid: dest.jid, source: dest.source, preview: text.slice(0, 100) }, 'LQC monitor: alert sent');
  } catch (err) {
    logger.error({ err: err.message, severity, jid: dest.jid }, 'LQC monitor: send failed');
  }
}

function minutesSince(isoOrNull) {
  if (!isoOrNull) return null;
  const t = Date.parse(isoOrNull);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60_000);
}

// ── Main tick ────────────────────────────────────────────────────────

export async function tickLqcMonitor() {
  if (!lqc.isEnabled()) return;

  // Seed state on first run: treat whatever is currently failed as
  // already-announced so restarts don't re-announce.
  if (!_seeded) {
    try {
      const existing = await lqc.listDebates({ limit: 50 });
      for (const d of existing || []) debateStatusSeen.set(d.id, d.status);
      _seeded = true;
    } catch (err) {
      logger.warn({ err: err.message }, 'LQC monitor: seed failed');
      return;
    }
  }

  try {
    const [debates, health] = await Promise.all([
      lqc.listDebates({ limit: 20 }),
      lqc.getDiagHealth().catch(() => null),
    ]);

    // ── Newly-failed debates ────────────────────────────────────────
    for (const d of debates || []) {
      const prev = debateStatusSeen.get(d.id);
      debateStatusSeen.set(d.id, d.status);
      if (prev === 'failed' || d.status !== 'failed') continue;
      await send(
        [
          `*LQ Council: debate failed*`,
          `ID: ${d.id}`,
          `Topic: ${d.topic}`,
          `Bots: ${d.bots.length}`,
          `Check \`lqc_debate_detail ${d.id}\` for specifics.`,
        ].join('\n'),
        'author',
      );
    }

    // ── Stuck-in-flight debates ─────────────────────────────────────
    const nonTerminal = (debates || []).filter(
      (d) => !['complete', 'failed', 'cancelled'].includes(d.status),
    );
    for (const d of nonTerminal) {
      const mins = minutesSince(d.created_at);
      if (mins == null || mins < STUCK_DEBATE_MINUTES) continue;
      const sig = `stuck:${d.id}`;
      if (!canFire(sig)) continue;
      await send(
        [
          `*LQ Council: debate stuck*`,
          `ID: ${d.id}`,
          `Status: ${d.status} — ${mins}m in flight (threshold ${STUCK_DEBATE_MINUTES}m)`,
          `Topic: ${d.topic}`,
        ].join('\n'),
        'ops',
      );
      markFired(sig);
    }

    // ── Health threshold ─────────────────────────────────────────────
    if (health && typeof health.failure_rate_1h === 'number' && health.failure_rate_1h > FAILURE_RATE_THRESHOLD) {
      const sig = 'health:failure_rate';
      if (canFire(sig)) {
        await send(
          [
            `*LQ Council: elevated failure rate*`,
            `Past hour: ${Math.round(health.failure_rate_1h * 100)}% (${health.failures_1h}/${health.terminal_1h}).`,
            `Release: ${health.release}`,
            `Use \`lqc_recent_errors\` or \`lqc_bot_diagnose\` to investigate.`,
          ].join('\n'),
          'ops',
        );
        markFired(sig);
      }
    }

    // ── Per-bot dominant error kind ─────────────────────────────────
    try {
      const bots = await lqc.listBots();
      const active = (bots || []).filter((b) => b.status === 'active');
      // Batch in groups of 5 to avoid hammering the API.
      for (let i = 0; i < active.length; i += 5) {
        const batch = active.slice(i, i + 5);
        const histories = await Promise.all(
          batch.map((b) => lqc.getBotHistory(b.id, { limit: 20 }).catch(() => [])),
        );
        for (let j = 0; j < batch.length; j++) {
          const bot = batch[j];
          const rows = histories[j] || [];
          if (rows.length < 5) continue;
          const kindCounts = new Map();
          for (const r of rows) {
            if (!r.error_kind) continue;
            kindCounts.set(r.error_kind, (kindCounts.get(r.error_kind) || 0) + 1);
          }
          if (kindCounts.size === 0) continue;
          const dominant = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0];
          const [kind, count] = dominant;
          if (count / rows.length < 0.4) continue; // must be >= 40% of rounds
          const prev = botDominantErrorKind.get(bot.id);
          if (prev === kind) continue;
          botDominantErrorKind.set(bot.id, kind);
          const sig = `bot-kind:${bot.id}:${kind}`;
          if (!canFire(sig)) continue;
          await send(
            [
              `*LQ Council: bot pattern shift*`,
              `Bot: ${bot.name} (${bot.id.slice(0, 8)})`,
              `Dominant failure kind: ${kind} (${count}/${rows.length} of recent rounds).`,
              `Run \`lqc_bot_diagnose ${bot.id}\` for specifics.`,
            ].join('\n'),
            'author',
          );
          markFired(sig);
        }
      }
    } catch (err) {
      // intentional: per-bot aggregation failures should not block
      // failed/stuck detection above
      logger.warn({ err: err.message }, 'LQC monitor: per-bot aggregation failed');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'LQC monitor: tick failed');
  }
}

/** Last-seen state, exposed for debugging (e.g. from overnight-status). */
export function getLqcMonitorState() {
  return {
    seededDebates: debateStatusSeen.size,
    botDominantKinds: Object.fromEntries(botDominantErrorKind),
    cooldowns: Array.from(signalCooldowns.entries()).map(([sig, t]) => ({
      signal: sig,
      msSince: Date.now() - t,
    })),
  };
}
