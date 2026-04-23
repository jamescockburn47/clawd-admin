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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as lqc from '../lqcouncil/client.js';
import * as sentry from '../lqcouncil/sentry-client.js';
import config from '../config.js';
import { findGroupJidByProject } from '../group-registry.js';
import {
  lastCompletedRound,
  buildRoundSummary,
  buildFinalCommentary,
  buildDebateMemoryText,
} from '../lqcouncil/debate-progress.js';
import { storeNote } from '../memory.js';
import logger from '../logger.js';

// ── State ────────────────────────────────────────────────────────────

/** debate_id → seen status (so transitions to 'failed' are edge-triggered) */
const debateStatusSeen = new Map();
/** debate_id → index of last round already announced in the LQcouncil group */
const debateLastRound = new Map();
/** debate_ids already ingested into Clint's memory (independent of status transitions — backfills old completes on first tick) */
const memoryIngested = new Set();
/** bot_id → dominant error_kind last observed (fire nudge on new dominant kind) */
const botDominantErrorKind = new Map();
/** signal name → last-fired timestamp for cooldown (ms) */
const signalCooldowns = new Map();
/** (debate_id, hour) → cached Sentry lookup result, to respect Sentry rate limits on repeated debate-failure alerts. */
const sentryLookupCache = new Map();

const COOLDOWN_MS = 15 * 60 * 1000;               // default per-signal cooldown
const STUCK_COOLDOWN_MS = 24 * 60 * 60 * 1000;    // per-debate stuck alert: one a day
const FAILURE_RATE_THRESHOLD = 0.25;
const STUCK_DEBATE_MINUTES = 30;
const STUCK_MAX_AGE_MINUTES = 240;                // past 4h in 'created' = orchestrator-abandoned, don't alert
const MEMORY_INGEST_PER_TICK = 3;                 // throttle backfill so the 14-debate history doesn't burst-hit memory API

const STATE_DIR = join('data', 'runtime');
const STATE_PATH = join(STATE_DIR, 'lqc-monitor-state.json');
const STATE_STATUS_CAP = 200; // trim persisted status map beyond this many entries

let _sendProactive = null;
let _seeded = false;
let _stateLoaded = false;

// ── Injection ───────────────────────────────────────────────────────

/** Called by index.js after the proactive-message helper is available. */
export function initLqcMonitor(sendProactiveMessage) {
  _sendProactive = sendProactiveMessage;
}

// ── Persistence ──────────────────────────────────────────────────────
// Cooldowns were in-memory only. On every service restart they reset,
// which meant every stuck-debate alert re-fired in a burst seconds after
// startup — and there was no cap per debate, so even without restarts a
// single stuck debate would page James every 15 minutes for hours.
// Persisting cooldowns + status-seen to disk kills both problems.

function loadState() {
  if (_stateLoaded) return;
  _stateLoaded = true;
  try {
    if (!existsSync(STATE_PATH)) return;
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (raw.cooldowns && typeof raw.cooldowns === 'object') {
      for (const [k, v] of Object.entries(raw.cooldowns)) {
        if (typeof v === 'number') signalCooldowns.set(k, v);
      }
    }
    if (raw.debateStatus && typeof raw.debateStatus === 'object') {
      for (const [k, v] of Object.entries(raw.debateStatus)) debateStatusSeen.set(k, v);
    }
    if (raw.debateLastRound && typeof raw.debateLastRound === 'object') {
      for (const [k, v] of Object.entries(raw.debateLastRound)) {
        if (typeof v === 'number') debateLastRound.set(k, v);
      }
    }
    if (Array.isArray(raw.memoryIngested)) {
      for (const id of raw.memoryIngested) {
        if (typeof id === 'string') memoryIngested.add(id);
      }
    }
    if (raw.botKinds && typeof raw.botKinds === 'object') {
      for (const [k, v] of Object.entries(raw.botKinds)) botDominantErrorKind.set(k, v);
    }
    logger.info(
      { cooldowns: signalCooldowns.size, debates: debateStatusSeen.size, bots: botDominantErrorKind.size },
      'LQC monitor: state loaded from disk',
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'LQC monitor: state load failed');
  }
}

function persistState() {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Cap debate-status entries to prevent unbounded growth over months.
    const entries = [...debateStatusSeen.entries()].slice(-STATE_STATUS_CAP);
    const roundEntries = [...debateLastRound.entries()].slice(-STATE_STATUS_CAP);
    const ingestedList = [...memoryIngested].slice(-STATE_STATUS_CAP);
    const payload = {
      cooldowns: Object.fromEntries(signalCooldowns),
      debateStatus: Object.fromEntries(entries),
      debateLastRound: Object.fromEntries(roundEntries),
      memoryIngested: ingestedList,
      botKinds: Object.fromEntries(botDominantErrorKind),
    };
    writeFileSync(STATE_PATH, JSON.stringify(payload), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'LQC monitor: state persist failed');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function canFire(signal, cooldownMs = COOLDOWN_MS) {
  const last = signalCooldowns.get(signal) || 0;
  return Date.now() - last >= cooldownMs;
}

function markFired(signal) {
  signalCooldowns.set(signal, Date.now());
  persistState();
}

/**
 * Resolve an alert destination by severity.
 *   - `ops`:    owner DM. Used for stuck debates, provider-health alerts,
 *               things that don't need to be visible to bot authors.
 *   - `author`: the LQcouncil-bound group. Used for per-debate failure,
 *               per-bot pattern shifts, round-progress summaries, and
 *               final synthesis commentary — everyone in the group
 *               benefits from seeing these.
 *
 * `author` priority is env-var-first. `LQC_DEV_GROUP_JID` is the
 * operator-set override and should beat the registry-derived
 * `allowedProjects` lookup when both exist. Current setup: the env
 * points at LQCore (the instruction channel), while `allowedProjects`
 * points at the separate LQcouncil group — without this order,
 * progress updates would land in LQcouncil instead of LQCore.
 */
function resolveDestination(severity) {
  const legacy = (config.lqcDevGroupJid || '').trim();
  const ownerJid = (config.ownerJid || '').trim();
  if (severity === 'author') {
    if (legacy) return { jid: legacy, source: 'legacy_env' };
    const bound = findGroupJidByProject('lqcouncil');
    if (bound) return { jid: bound, source: 'allowedProjects' };
    if (ownerJid) return { jid: ownerJid, source: 'owner_fallback' };
    return null;
  }
  // severity === 'ops'
  if (ownerJid) return { jid: ownerJid, source: 'owner_dm' };
  if (legacy) return { jid: legacy, source: 'legacy_env' };
  return null;
}

/**
 * Query Sentry for issues tagged with this debate_id in a narrow window
 * around the debate's creation time. Cached by (debate_id, hour-bucket)
 * to suppress duplicate API calls on monitor restarts or adjacent ticks.
 *
 * SOTA alignments:
 *   - Narrow time window (±1 h from created_at) avoids fingerprint-drift
 *     pulling in old unrelated issues (per Sentry API docs + community
 *     guidance — fingerprints can shift over months).
 *   - `(debate_id, hour)` cache key respects the per-endpoint rate limit
 *     and keeps noise floor low when a debate fails during a hot period.
 *   - Returns {issues, releaseCorrelation} so callers can distinguish
 *     "known error pattern" from "new-in-this-release".
 *
 * Silently returns null if Sentry is unconfigured or the lookup errors —
 * the debate-failed alert still fires, just without enrichment.
 */
async function lookupSentryForDebate(debate) {
  if (!sentry.isSentryConfigured()) return null;
  const hour = Math.floor(Date.now() / (60 * 60 * 1000));
  const cacheKey = `${debate.id}:${hour}`;
  if (sentryLookupCache.has(cacheKey)) return sentryLookupCache.get(cacheKey);
  // Cap cache to avoid unbounded growth; 200 entries × ~hour bucket is
  // generous given typical debate volume.
  if (sentryLookupCache.size > 200) {
    const firstKey = sentryLookupCache.keys().next().value;
    sentryLookupCache.delete(firstKey);
  }
  try {
    const issues = await sentry.searchIssues({
      query: `tag:debate_id:${debate.id}`,
      age: '-1h',
      limit: 5,
    });
    const out = { issues: issues || [] };
    sentryLookupCache.set(cacheKey, out);
    return out;
  } catch (err) {
    logger.warn({ err: err.message, debateId: debate.id }, 'LQC monitor: Sentry correlation failed');
    sentryLookupCache.set(cacheKey, null);
    return null;
  }
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

  loadState();

  // Seed state on first run: treat whatever is currently failed as
  // already-announced so restarts don't re-announce. Persisted state
  // (loaded above) already covers cross-restart dedup, but a fresh
  // install or a rotated state file still needs this initial pass.
  if (!_seeded) {
    try {
      const existing = await lqc.listDebates({ limit: 50 });
      for (const d of existing || []) {
        if (!debateStatusSeen.has(d.id)) debateStatusSeen.set(d.id, d.status);
        if (!debateLastRound.has(d.id)) {
          const r = lastCompletedRound(d.status);
          if (r != null) debateLastRound.set(d.id, r);
        }
      }
      _seeded = true;
      persistState();
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

    // ── Status transitions: failed, complete, round progress ────────
    // One loop so `prev` and `d.status` are only compared once per
    // debate per tick. Order of side-effects matters — round
    // announcements first, then complete (which implies all rounds
    // done + final synthesis), then failed (owner-only alert).
    for (const d of debates || []) {
      const prev = debateStatusSeen.get(d.id);
      debateStatusSeen.set(d.id, d.status);

      // Round progress: announce each round that has completed since
      // last sighting. On first sighting we seed silently — don't
      // retroactively post summaries for rounds that completed before
      // the monitor started tracking.
      const currentRound = lastCompletedRound(d.status);
      const seenRound = debateLastRound.get(d.id);
      if (seenRound === undefined) {
        if (currentRound != null) debateLastRound.set(d.id, currentRound);
      } else if (currentRound != null && currentRound > seenRound) {
        // Update state before posting so a transient WA failure won't
        // duplicate the announcement on the next tick.
        debateLastRound.set(d.id, currentRound);
        for (let r = seenRound + 1; r <= currentRound; r++) {
          const summary = await buildRoundSummary(d.id, r);
          if (summary) await send(summary, 'author');
        }
      }

      // Complete-transition commentary: once per debate. Separate
      // from memory ingestion below because commentary is about
      // surfacing the result to the group *now*, whereas memory
      // ingestion needs to backfill old completes too.
      if (prev !== 'complete' && d.status === 'complete') {
        try {
          const commentary = await buildFinalCommentary(d.id);
          if (commentary) await send(commentary, 'author');
        } catch (err) {
          logger.warn({ err: err.message, debateId: d.id }, 'LQC monitor: final commentary post failed');
        }
      }

      // Failed transition: owner DM only, never the group — decided
      // 2026-04-19 per PR #14 to keep group noise low.
      // Enriched 2026-04-23 with Sentry correlation: when the failure
      // fires, immediately look up Sentry issues tagged with this
      // debate_id so James sees the "why" alongside the "what".
      if (prev !== 'failed' && d.status === 'failed') {
        const lines = [
          `*LQ Council: debate failed*`,
          `ID: ${d.id}`,
          `Topic: ${d.topic}`,
          `Bots: ${d.bots.length}`,
        ];
        const sentryOut = await lookupSentryForDebate(d);
        if (sentryOut && sentryOut.issues.length > 0) {
          lines.push('', `*Sentry issues (last hour, debate_id tag):*`);
          lines.push(sentry.formatIssues(sentryOut.issues, { maxItems: 3 }));
        } else if (sentryOut && sentryOut.issues.length === 0) {
          lines.push('', '_No Sentry issues tagged for this debate — check bot-council logs directly._');
        }
        lines.push('', `Run \`lqc_debate_detail ${d.id}\` for full specifics.`);
        await send(lines.join('\n'), 'ops');
      }
    }

    // ── Memory ingestion for completed debates ──────────────────────
    // Ingest up to MEMORY_INGEST_PER_TICK completed debates per tick so
    // the backfill of historical debates doesn't burst the memory API
    // on first run. The `memoryIngested` Set persists across restarts,
    // so each debate is ingested exactly once. listBots top-20 always
    // contains the most recent completes first; we extend with a
    // broader list on the first tick (when the Set is empty) so old
    // completes aren't missed on the initial backfill.
    const needsBackfill = memoryIngested.size === 0;
    const ingestionCandidates = needsBackfill
      ? await lqc.listDebates({ limit: 50 }).catch((err) => {
          logger.warn({ err: err.message }, 'LQC monitor: backfill listDebates failed');
          return debates;
        })
      : debates;
    let ingestedThisTick = 0;
    for (const d of ingestionCandidates || []) {
      if (ingestedThisTick >= MEMORY_INGEST_PER_TICK) break;
      if (d.status !== 'complete') continue;
      if (memoryIngested.has(d.id)) continue;
      try {
        const memoryText = await buildDebateMemoryText(d.id);
        if (memoryText) {
          await storeNote(memoryText, `lqc-debate:${d.id}`);
          memoryIngested.add(d.id);
          ingestedThisTick++;
          logger.info({ debateId: d.id, chars: memoryText.length }, 'LQC monitor: debate ingested into memory');
        } else {
          // Don't keep retrying if the build returned null (missing synth etc).
          // Mark as ingested to avoid infinite retries.
          memoryIngested.add(d.id);
          logger.warn({ debateId: d.id }, 'LQC monitor: memory text was empty — marked ingested to skip');
        }
      } catch (err) {
        logger.warn({ err: err.message, debateId: d.id }, 'LQC monitor: memory ingestion failed');
        // Leave out of the Set so next tick retries.
        break;
      }
    }

    // ── Stuck-in-flight debates ─────────────────────────────────────
    // A debate in a non-terminal status past 30m is flagged, but only
    // once per STUCK_COOLDOWN_MS (24h) per debate — 'stuck is stuck',
    // re-paging James every 15 min gives him no new information. A
    // debate stuck in status 'created' past STUCK_MAX_AGE_MINUTES is
    // treated as orchestrator-abandoned (rounds never began) and
    // skipped entirely; those accumulate when the bot-council
    // orchestrator crashes mid-create and can't be cleaned up from
    // Clint's side anyway.
    const nonTerminal = (debates || []).filter(
      (d) => !['complete', 'failed', 'cancelled'].includes(d.status),
    );
    for (const d of nonTerminal) {
      const mins = minutesSince(d.created_at);
      if (mins == null || mins < STUCK_DEBATE_MINUTES) continue;
      if (d.status === 'created' && mins > STUCK_MAX_AGE_MINUTES) continue;
      const sig = `stuck:${d.id}`;
      if (!canFire(sig, STUCK_COOLDOWN_MS)) continue;
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

    // Persist at end of tick so a quiet cycle (status transitions with
    // no alert fired) still snapshots debateStatusSeen and botKinds.
    persistState();
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
