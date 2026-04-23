// src/tasks/lqc-daily-health.js — daily 08:45 London all-systems health
// post to the owner DM (or LQC_HEALTH_GROUP_JID when set).
//
// Fills a gap the existing LQC tasks leave: the 60s monitor posts only
// on edge-triggered transitions, the failure nudge fires only when a
// bot crosses a 70% failure rate, and the weekly digest is weekly. None
// surface "everything is normal" or let James spot drift early.
//
// Six sections, each independently try/catch'd so one upstream failure
// surfaces as "check failed: <err>" instead of dropping the whole post.
// The rule is explicit visibility — James cannot act on silent gaps.
//
// Routing:
//   - default: config.ownerJid (James DM). Private by default because
//     Sentry issue titles and bot-author identities can leak.
//   - override: LQC_HEALTH_GROUP_JID — redirect to a group when James
//     wants bot authors to see it too.
//
// State persistence mirrors weekly-digest: idempotent per London-day
// via data/runtime/lqc-daily-health-last-run.txt.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as lqc from '../lqcouncil/client.js';
import * as sentry from '../lqcouncil/sentry-client.js';
import config from '../config.js';
import logger from '../logger.js';

const STATE_DIR = join('data', 'runtime');
const STATE_PATH = join(STATE_DIR, 'lqc-daily-health-last-run.txt');
const BASELINE_PATH = join(STATE_DIR, 'lqc-sentry-baseline.json');
const PROPOSALS_DIR = join('data', 'overnight', 'proposals');
const HEALTH_HOUR = 8;
const HEALTH_MINUTE = 45;

const DAY_MS = 24 * 60 * 60 * 1000;
const BOT_FLEET_HISTORY_LIMIT = 20;
const BOT_FLEET_WARN_RATE = 0.3;        // softer than nudge's 0.7 — early warning
const MIN_ROUNDS_FOR_RATE = 5;          // don't flag bots with <5 rounds signal
const SENTRY_TOP_ISSUES = 3;
const DRIFT_LOOKBACK_MS = 30 * 60 * 60 * 1000; // 30h covers the 02:10 drift run

// Rolling baseline for Sentry 24h counts — SOTA-appropriate for
// low-volume services (single-digit to low-hundreds/day). Research
// shows Prophet / seasonal decomposition assumes much higher volume;
// rolling median + ±50% flag is what the literature converges on for
// this regime (plus Sentry's native Anomaly Alerts, which we use as
// complementary signal in the UI).
const BASELINE_RING_DAYS = 14;
const BASELINE_SPIKE_FACTOR = 1.5;
const BASELINE_QUIET_FACTOR = 0.5;

let _sendProactive = null;

export function initDailyHealth(sendProactiveMessage) {
  _sendProactive = sendProactiveMessage;
}

// ── State (idempotent per London-day) ───────────────────────────────

function loadLast() {
  try {
    return existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function saveLast(isoDate) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, isoDate, 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'daily health: state persist failed');
  }
}

function targetJid() {
  const override = (process.env.LQC_HEALTH_GROUP_JID || '').trim();
  if (override) return override;
  return (config.ownerJid || '').trim();
}

// ── Section builders ────────────────────────────────────────────────
// Each returns a string. On failure returns an explicit "check failed"
// line — silence is not acceptable per the visibility rule.

async function buildBackendSection() {
  try {
    const [health, publicConfig] = await Promise.all([
      lqc.getDiagHealth().catch((err) => ({ _err: err.message })),
      lqc.getPublicConfig().catch(() => null),
    ]);
    const lines = ['*Backend*'];
    if (health && health._err) {
      lines.push(`  /api/diag/health: FAIL — ${health._err}`);
    } else if (health && health.status === 'ok') {
      lines.push('  /api/diag/health: ok');
      if (Number.isFinite(health.debates_in_flight)) {
        lines.push(`  in-flight debates: ${health.debates_in_flight}`);
      }
      if (health.last_completion_ts) {
        lines.push(`  last completion: ${health.last_completion_ts}`);
      }
    } else {
      lines.push(`  /api/diag/health: unexpected response — ${JSON.stringify(health).slice(0, 120)}`);
    }
    if (publicConfig && publicConfig.release) {
      lines.push(`  release: ${publicConfig.release}`);
    }
    return lines.join('\n');
  } catch (err) {
    return `*Backend*\n  check failed: ${err.message}`;
  }
}

async function buildActivitySection() {
  try {
    const debates = await lqc.listDebates({ limit: 100 });
    const now = Date.now();
    const cutoff24h = now - DAY_MS;
    const cutoff48h = now - 2 * DAY_MS;
    const last24h = (debates || []).filter((d) => {
      const t = Date.parse(d.created_at);
      return Number.isFinite(t) && t >= cutoff24h;
    });
    const prior24h = (debates || []).filter((d) => {
      const t = Date.parse(d.created_at);
      return Number.isFinite(t) && t >= cutoff48h && t < cutoff24h;
    });
    const categorise = (list) => ({
      complete: list.filter((d) => d.status === 'complete').length,
      failed: list.filter((d) => d.status === 'failed').length,
      inFlight: list.filter((d) => !['complete', 'failed', 'cancelled'].includes(d.status)).length,
    });
    const now24 = categorise(last24h);
    const prior = categorise(prior24h);
    const delta = last24h.length - prior24h.length;
    const deltaSign = delta > 0 ? `+${delta}` : `${delta}`;
    return [
      '*Activity (24h)*',
      `  debates: ${last24h.length} (${deltaSign} vs prior 24h) — complete ${now24.complete}, failed ${now24.failed}, in-flight ${now24.inFlight}`,
    ].join('\n');
  } catch (err) {
    return `*Activity (24h)*\n  check failed: ${err.message}`;
  }
}

async function buildLlmRoutingSection() {
  try {
    const models = await lqc.getModelsDiag();
    const analysis = models.analysis_model || models.analyser_model || '?';
    const synthesis = models.final_synthesis_model || models.synthesis_model || '?';
    return ['*LLM routing*', `  analyser: ${analysis}`, `  synthesis: ${synthesis}`].join('\n');
  } catch (err) {
    // Admin-gated endpoint — common in a daily health context. Keep it
    // informative rather than alarming.
    const msg = /unauthori[sz]ed|401|403/i.test(err.message)
      ? 'admin-gated (set LQC_ADMIN_TOKEN to expose)'
      : `check failed: ${err.message}`;
    return `*LLM routing*\n  ${msg}`;
  }
}

async function buildBotFleetSection() {
  try {
    const bots = await lqc.listBots();
    const list = bots || [];
    const byStatus = new Map();
    for (const b of list) byStatus.set(b.status, (byStatus.get(b.status) || 0) + 1);
    const active = list.filter((b) => b.status === 'active');
    const lines = ['*Bot fleet*'];
    const summary = [...byStatus.entries()]
      .map(([status, n]) => `${status}=${n}`)
      .sort()
      .join(', ');
    lines.push(`  ${summary || 'no bots'}`);

    if (active.length > 0) {
      const warnings = [];
      const histories = await Promise.all(
        active.map(async (bot) => {
          const history = await lqc
            .getBotHistory(bot.id, { limit: BOT_FLEET_HISTORY_LIMIT })
            .catch(() => []);
          let totalRounds = 0;
          let badRounds = 0;
          for (const d of history) {
            totalRounds += d.rounds_total || 0;
            badRounds += (d.abstained_rounds || 0) + (d.invalid_rounds || 0);
          }
          return { bot, totalRounds, badRounds };
        }),
      );
      for (const h of histories) {
        if (h.totalRounds < MIN_ROUNDS_FOR_RATE) continue;
        const rate = h.badRounds / h.totalRounds;
        if (rate >= BOT_FLEET_WARN_RATE) {
          warnings.push(`  ⚠ ${h.bot.name}: ${Math.round(rate * 100)}% abstain/invalid (${h.badRounds}/${h.totalRounds})`);
        }
      }
      if (warnings.length > 0) {
        lines.push('');
        lines.push('  Early-warning (≥30% over last 20 rounds):');
        lines.push(...warnings);
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `*Bot fleet*\n  check failed: ${err.message}`;
  }
}

/**
 * Rolling 14-day Sentry baseline — pure state functions so tests can
 * drive deterministic inputs.
 */
export function loadBaseline(path = BASELINE_PATH) {
  try {
    if (!existsSync(path)) return { counts: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { counts: {} };
    return { counts: parsed.counts || {} };
  } catch {
    return { counts: {} };
  }
}

export function saveBaseline(state, path = BASELINE_PATH) {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'daily health: baseline persist failed');
  }
}

/**
 * Record today's count into the baseline, trim to last BASELINE_RING_DAYS,
 * return a human-readable annotation string for the daily-health post.
 * Rolling MEDIAN (not mean) is used because low-volume streams are
 * skewed by the occasional spike; median is robust.
 */
export function updateBaselineAndAnnotate({ project, count, today, state }) {
  if (!state.counts[project]) state.counts[project] = {};
  state.counts[project][today] = count;

  // Trim to last N days.
  const dates = Object.keys(state.counts[project]).sort();
  while (dates.length > BASELINE_RING_DAYS) {
    const oldest = dates.shift();
    delete state.counts[project][oldest];
  }

  // Need at least 3 historical points (excluding today) to flag.
  const history = Object.entries(state.counts[project])
    .filter(([d]) => d !== today)
    .map(([, v]) => v)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (history.length < 3) {
    return `  (baseline learning: ${history.length + 1}/14 days of history)`;
  }
  const median = history[Math.floor(history.length / 2)];
  if (median === 0 && count === 0) return '  (no errors today, baseline 0)';
  if (median === 0 && count > 0) return `  ⚠ ${count} vs 14-day median 0 — new error surface`;
  const ratio = count / median;
  if (ratio >= BASELINE_SPIKE_FACTOR) {
    return `  ⚠ ${count} vs 14-day median ${median} (${ratio.toFixed(1)}× — spike)`;
  }
  if (count > 0 && ratio <= BASELINE_QUIET_FACTOR) {
    return `  • ${count} vs 14-day median ${median} (${ratio.toFixed(2)}× — quieter than usual)`;
  }
  return `  • ${count} vs 14-day median ${median} (within normal range)`;
}

async function buildSentrySection(now = Date.now(), baselinePath = BASELINE_PATH) {
  if (!sentry.isSentryConfigured()) {
    return '*Error tracing (24h)*\n  Sentry not configured — set LQC_SENTRY_API_TOKEN/ORG/PROJECT_BACKEND';
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const state = loadBaseline(baselinePath);
  try {
    const backend = await sentry.searchIssues({ age: '-24h', limit: 10 });
    const lines = ['*Error tracing (24h)*'];
    lines.push(`  backend: ${backend.length} issue group${backend.length === 1 ? '' : 's'}`);
    lines.push(updateBaselineAndAnnotate({ project: 'backend', count: backend.length, today, state }));
    if (backend.length > 0) {
      lines.push(sentry.formatIssues(backend, { maxItems: SENTRY_TOP_ISSUES }));
    }

    const frontendProject = (config.lqcSentryProjectFrontend || '').trim();
    if (frontendProject) {
      try {
        const frontend = await sentry.searchIssues({
          age: '-24h',
          limit: 10,
          project: frontendProject,
        });
        lines.push(`  frontend: ${frontend.length} issue group${frontend.length === 1 ? '' : 's'}`);
        lines.push(updateBaselineAndAnnotate({ project: 'frontend', count: frontend.length, today, state }));
        if (frontend.length > 0) {
          lines.push(sentry.formatIssues(frontend, { maxItems: SENTRY_TOP_ISSUES }));
        }
      } catch (err) {
        lines.push(`  frontend: check failed — ${err.message}`);
      }
    } else {
      lines.push('  frontend: project slug not set (LQC_SENTRY_PROJECT_FRONTEND)');
    }

    // Persist updated baseline only after a successful render so a
    // partial-failure doesn't corrupt the ring.
    saveBaseline(state, baselinePath);

    return lines.join('\n');
  } catch (err) {
    return `*Error tracing (24h)*\n  check failed: ${err.message}`;
  }
}

function buildKnowledgeDriftSection(now = Date.now(), proposalsDir = PROPOSALS_DIR) {
  try {
    if (!existsSync(proposalsDir)) {
      return '*Knowledge drift (24h)*\n  no proposals dir yet (drift detector has not run)';
    }
    const entries = readdirSync(proposalsDir).filter((f) => f.startsWith('lqc-knowledge-drift-') && f.endsWith('.json'));
    const recent = entries
      .map((f) => {
        const full = join(proposalsDir, f);
        try {
          const s = statSync(full);
          return { file: f, mtimeMs: s.mtimeMs, full };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((e) => now - e.mtimeMs <= DRIFT_LOOKBACK_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (recent.length === 0) {
      return '*Knowledge drift (24h)*\n  none detected (drift detector clean)';
    }
    const lines = ['*Knowledge drift (24h)*'];
    for (const e of recent.slice(0, 3)) {
      try {
        const payload = JSON.parse(readFileSync(e.full, 'utf8'));
        const changes = (payload.changes || []).filter((c) => c.kind !== 'initial-snapshot');
        const summary = changes.length === 0
          ? 'no actionable changes'
          : changes.map((c) => {
              if (c.kind === 'array-diff') {
                const parts = [];
                if (c.added?.length) parts.push(`+${c.field}:${c.added.join(',')}`);
                if (c.removed?.length) parts.push(`-${c.field}:${c.removed.join(',')}`);
                return parts.join(' ');
              }
              if (c.kind === 'scalar-diff') return `${c.field}: ${c.old}→${c.new}`;
              return c.kind;
            }).join('; ');
        lines.push(`  ⚠ ${e.file}: ${summary}`);
      } catch (err) {
        lines.push(`  ⚠ ${e.file}: unreadable (${err.message})`);
      }
    }
    lines.push('  Review data/overnight/proposals/ and refresh data/lqcouncil-knowledge.json as needed.');
    return lines.join('\n');
  } catch (err) {
    return `*Knowledge drift (24h)*\n  check failed: ${err.message}`;
  }
}

// ── Entry points ────────────────────────────────────────────────────

/**
 * Build the full daily-health text. Returns null only when the LQC
 * integration is disabled outright.
 */
export async function buildDailyHealth({
  now = Date.now(),
  proposalsDir = PROPOSALS_DIR,
  baselinePath = BASELINE_PATH,
} = {}) {
  if (!lqc.isEnabled()) return null;
  const [backend, activity, routing, fleet, sentrySection] = await Promise.all([
    buildBackendSection(),
    buildActivitySection(),
    buildLlmRoutingSection(),
    buildBotFleetSection(),
    buildSentrySection(now, baselinePath),
  ]);
  const drift = buildKnowledgeDriftSection(now, proposalsDir);
  const header = `*LQ Council daily health* — ${new Date(now).toISOString().slice(0, 10)}`;
  return [header, '', backend, '', activity, '', routing, '', fleet, '', sentrySection, '', drift].join('\n');
}

/** Scheduler entry: fire at 08:45 London once per day. */
export async function checkDailyHealth(todayStr, hours, minutes) {
  if (hours !== HEALTH_HOUR || minutes !== HEALTH_MINUTE) return;
  if (loadLast() === todayStr) return;
  if (!_sendProactive) return;
  const jid = targetJid();
  if (!jid) {
    logger.info('daily health: no owner JID / LQC_HEALTH_GROUP_JID — skipping');
    saveLast(todayStr);
    return;
  }
  try {
    const text = await buildDailyHealth();
    if (!text) {
      saveLast(todayStr);
      return;
    }
    await _sendProactive(jid, text);
    saveLast(todayStr);
    logger.info({ jid, chars: text.length }, 'daily health sent');
  } catch (err) {
    logger.error({ err: err.message }, 'daily health failed');
  }
}

/** Manual trigger for scripts/run-task.js / dashboard button. */
export async function runDailyHealthNow() {
  if (!_sendProactive) throw new Error('not initialised');
  const jid = targetJid();
  if (!jid) throw new Error('no target JID set');
  const text = await buildDailyHealth();
  if (!text) throw new Error('LQ integration disabled');
  await _sendProactive(jid, text);
  return { delivered: true, jid, preview: text.slice(0, 240) };
}
