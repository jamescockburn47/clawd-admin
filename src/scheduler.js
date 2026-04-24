// Scheduler — 60-second interval, dispatches all scheduled tasks.
// Each task is isolated: one failing task doesn't block others.
//
// Phase 5 retirement: checkOvernightExtraction, checkSelfImprovement,
// checkProjectDeepThink, checkOvernightReport, checkWeeklyRetrospective,
// checkOvernightEvolution, checkForge, checkEvolutionTasks are all removed.
// Their functionality is replaced by the new consolidate/probe/report/improve
// four-stage overnight pipeline. See:
//   docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md

import { checkEvoHealth, isEvoOnline, syncCache, getEvoStatus } from './memory.js';
import { keepEvoWarm } from './evo-llm.js';
import { checkTodoReminders } from './tasks/todo-reminders.js';
import { checkSideGigMeetings } from './tasks/meeting-alerts.js';
import { checkMorningBriefing, checkWeeklyReview, getLastBriefingDate, getLastReviewDate } from './tasks/briefing.js';
import { checkDailyBackup, getLastBackupDate } from './tasks/daily-backup.js';
import { checkSystemKnowledgeRefresh, getLastKnowledgeRefreshDate } from './tasks/system-refresh.js';
import { checkTraceAnalysis, getLastAnalysisDate } from './tasks/trace-analyser.js';
import { checkGroundTruth, getLastHarvestDate } from './tasks/ground-truth.js';
import { checkProjectKnowledgeSync, getLastProjectSyncDate } from './tasks/project-sync.js';
import { checkSovrenCrossReference } from './tasks/sovren-contribution-cross-reference.js';
import { checkConsolidateShadow } from './overnight/consolidate-shadow-task.js';
import { checkProbe } from './overnight/probe-task.js';
import { checkReport } from './overnight/report-task.js';
import { checkImprove } from './overnight/improve-task.js';
import { tickLqcMonitor } from './tasks/lqc-monitor.js';
import { checkWeeklyDigest } from './tasks/lqc-weekly-digest.js';
import { checkFailureNudge } from './tasks/lqc-bot-failure-nudge.js';
import { checkKnowledgeDrift } from './tasks/lqc-knowledge-drift.js';
import { checkDailyHealth } from './tasks/lqc-daily-health.js';
import { checkRepoPoll } from './tasks/lqc-repo-poll.js';
import { checkGoldenQuestions } from './tasks/golden-questions.js';
import { checkTrajectorySnapshots } from './tasks/trajectory-snapshot.js';
import config from './config.js';
import logger from './logger.js';

// Get London time components reliably (avoids en-GB date string parsing issues)
function getLondonTime() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    parts[type] = value;
  }
  const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
  const hours = parseInt(parts.hour, 10);
  const minutes = parseInt(parts.minute, 10);
  // Derive day-of-week from the London date string to avoid TZ skew on
  // the server (new Date(todayStr).getDay() treats the string as UTC
  // midnight, which is fine because the local date is what we care
  // about — Sunday-in-London).
  const dayOfWeek = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return { todayStr, hours, minutes, dayOfWeek, now };
}

let sendFn = null;
let lastCacheSyncMinute = null;

export function initScheduler(sendMessage) {
  sendFn = sendMessage;
  runScheduler();
  setInterval(runScheduler, 60 * 1000);
  logger.info('scheduler started (60s interval)');
}

// Expose subsystem status for dashboard admin panel
export function getSystemHealth() {
  const evo = getEvoStatus();
  return {
    whatsapp: { connected: !!sendFn },
    evo: { online: evo.online, queueDepth: evo.queueDepth || 0 },
    briefing: { enabled: !!config.briefingEnabled, lastRun: getLastBriefingDate() },
    knowledgeRefresh: { enabled: !!config.evoMemoryEnabled, lastRun: getLastKnowledgeRefreshDate() },
    traceAnalysis: { enabled: true, lastRun: getLastAnalysisDate() },
    groundTruth: { enabled: true, lastRun: getLastHarvestDate() },
    projectSync: { enabled: true, lastRun: getLastProjectSyncDate() },
    weeklyReview: { enabled: true, lastRun: getLastReviewDate() },
    backup: { lastRun: getLastBackupDate() },
    // New four-stage overnight pipeline — dates come from the event log,
    // not from module-level state, so we expose them as "see event log".
    consolidate: { enabled: true, source: 'data/overnight/events-<date>.jsonl' },
    probe: { enabled: true, source: 'data/overnight/events-<date>.jsonl' },
    report: { enabled: true, source: 'data/overnight/events-<date>.jsonl' },
    improve: { enabled: true, schedule: 'Saturday 22:00 London', source: 'data/overnight/events-<date>.jsonl' },
    scheduler: {
      lastTickMs,
      lastTickStats,
      slowTaskWarnMs: SLOW_TASK_WARN_MS,
      tickOverlapWarnMs: TICK_OVERLAP_WARN_MS,
    },
  };
}

// Per-task rolling stats: task name → { count, totalMs, maxMs, overBudgetMs }.
// Exposed via getTaskStats() for dashboard/debug. Reset never; clears naturally
// on process restart. SOTA-aligned: p95 matters more than mean for small-sample
// scheduler latency (tinybird, risingwave anomaly-detection guidance).
const taskStats = new Map();
let lastTickStats = null;
let lastTickMs = 0;

const SLOW_TASK_WARN_MS = 10_000;     // warn when a single task >10s
const TICK_OVERLAP_WARN_MS = 45_000;  // warn when a full tick >45s (overlap risk)

function recordTaskStat(name, durationMs) {
  const s = taskStats.get(name) || { count: 0, totalMs: 0, maxMs: 0, overBudgetMs: 0 };
  s.count += 1;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  if (durationMs > SLOW_TASK_WARN_MS) s.overBudgetMs += 1;
  taskStats.set(name, s);
}

export function getTaskStats() {
  return {
    lastTickMs,
    lastTickStats,
    perTask: Object.fromEntries(
      [...taskStats.entries()].map(([name, s]) => [name, {
        count: s.count,
        totalMs: s.totalMs,
        maxMs: s.maxMs,
        meanMs: Math.round(s.totalMs / Math.max(s.count, 1)),
        overBudgetCount: s.overBudgetMs,
      }]),
    ),
  };
}

async function runTask(name, fn) {
  const started = performance.now();
  try {
    await fn();
  } catch (err) {
    logger.error({ task: name, err: err.message }, 'scheduler task failed');
    // Capture-and-continue: scheduler tasks that throw don't block the
    // next task (that's runTask's whole point), but we want the error
    // surfaced in Sentry rather than lost to the journal. No-op when
    // Sentry unconfigured. Dynamic import so the scheduler module can
    // load before Sentry is initialised.
    try {
      const { captureException } = await import('./sentry.js');
      await captureException(err, { tags: { subsystem: 'scheduler', task: name } });
    } catch { /* intentional: sentry-capture failures must not cascade */ }
  } finally {
    const durationMs = Math.round(performance.now() - started);
    recordTaskStat(name, durationMs);
    if (durationMs > SLOW_TASK_WARN_MS) {
      logger.warn({ task: name, durationMs }, 'scheduler task exceeded budget');
    }
  }
}

async function runScheduler() {
  const tickStart = performance.now();
  const { todayStr, hours, minutes, dayOfWeek } = getLondonTime();

  // Check EVO health first -- briefing and other tasks read cached status
  if (config.evoMemoryEnabled) {
    await runTask('evoHealth', () => checkEvoHealth());
  }

  // Daytime user-facing tasks
  await runTask('todoReminders', () => checkTodoReminders(sendFn));
  await runTask('sideGigMeetings', () => checkSideGigMeetings(sendFn));
  await runTask('morningBriefing', () => checkMorningBriefing(sendFn, todayStr, hours, minutes));
  await runTask('weeklyReview', () => checkWeeklyReview(sendFn, todayStr, hours));

  // New four-stage overnight pipeline (spec §4)
  await runTask('consolidateShadow', () => checkConsolidateShadow(todayStr, hours, minutes));
  await runTask('probe', () => checkProbe(todayStr, hours, minutes));
  await runTask('report', () => checkReport(todayStr, hours, minutes));
  await runTask('improve', () => checkImprove(todayStr, hours, minutes));

  // Retained operational tasks (spec §8 "What gets kept")
  await runTask('systemKnowledgeRefresh', () => checkSystemKnowledgeRefresh(todayStr, hours));
  await runTask('projectKnowledgeSync', () => checkProjectKnowledgeSync(todayStr, hours));
  await runTask('traceAnalysis', () => checkTraceAnalysis(sendFn, todayStr, hours));
  await runTask('sovrenCrossReference', () => checkSovrenCrossReference(todayStr, hours, minutes));
  await runTask('groundTruth', () => checkGroundTruth(sendFn, todayStr, hours, minutes));
  await runTask('dailyBackup', () => checkDailyBackup(todayStr, hours));

  // LQ Bot Council — polls failure/stuck/health-threshold signals, posts
  // edge-triggered alerts to LQC_DEV_GROUP_JID (no-op if that JID is empty).
  await runTask('lqcMonitor', () => tickLqcMonitor());
  // Sunday 09:00 London — weekly digest.
  await runTask('lqcWeeklyDigest', () => checkWeeklyDigest(todayStr, hours, minutes, dayOfWeek));
  // Daily 10:00 London — nudge for bots failing > LQC_NUDGE_FAILURE_THRESHOLD.
  await runTask('lqcFailureNudge', () => checkFailureNudge(todayStr, hours, minutes));
  // Daily 02:10 London — check whether bot-council source has drifted from
  // the facts baked into data/lqcouncil-knowledge.json.
  await runTask('lqcKnowledgeDrift', () => checkKnowledgeDrift(todayStr, hours, minutes));
  // Daily 08:45 London — all-systems health post to owner DM (or
  // LQC_HEALTH_GROUP_JID override).
  await runTask('lqcDailyHealth', () => checkDailyHealth(todayStr, hours, minutes));
  // Every 15 minutes — poll bot-council main HEAD via GitHub; run
  // drift check on any SHA change. Belt-and-braces with the push-based
  // /api/lqcouncil-knowledge-refresh webhook.
  await runTask('lqcRepoPoll', () => checkRepoPoll(todayStr, hours, minutes));
  // Nightly 03:30 London — frozen Q&A contract tests against Clint's
  // full response pipeline. Grades each answer against expected
  // concepts; flags regression if today's pass-rate drops >15pp below
  // the trailing-3-run median.
  await runTask('goldenQuestions', () => checkGoldenQuestions(todayStr, hours, minutes));
  // Nightly 03:45 London — tool-trajectory assertions against canonical
  // prompts. Catches classifier re-routing and tool-loop degradation.
  await runTask('trajectorySnapshot', () => checkTrajectorySnapshots(todayStr, hours, minutes));

  // Sync cache every 30 minutes (at :00 and :30) when EVO memory is online
  if (config.evoMemoryEnabled && isEvoOnline()) {
    if (minutes % 30 === 0 && lastCacheSyncMinute !== minutes) {
      lastCacheSyncMinute = minutes;
      syncCache().catch(() => {});
    }
  }

  // Keep EVO X2 Qwen3.6-27B warm EVERY TICK (60 s). 10-minute cadence was
  // set for the older small-model topology; on a 27B dense with mlock'd
  // weights the concern is GPU power-state downclock during idle, which
  // can happen in seconds. A small ping every minute keeps clocks up and
  // the classifier prompt cache primed without meaningful cost
  // (max_tokens=1, ~100-200 ms per ping).
  if (config.evoToolEnabled) {
    keepEvoWarm().catch(() => {});
  }

  // Tick-wide timing. Warn on overlap risk (>45s) so we see tick
  // contention before tasks start queueing. Info log includes top 5
  // slowest tasks this tick so a single slow upstream is immediately
  // visible without grepping.
  lastTickMs = Math.round(performance.now() - tickStart);
  const perTaskThisTick = [...taskStats.entries()]
    .map(([name, s]) => ({ name, lastMs: s.maxMs, mean: Math.round(s.totalMs / Math.max(s.count, 1)) }))
    .sort((a, b) => b.lastMs - a.lastMs)
    .slice(0, 5);
  lastTickStats = { tickMs: lastTickMs, topSlow: perTaskThisTick };
  if (lastTickMs > TICK_OVERLAP_WARN_MS) {
    logger.warn({ tickMs: lastTickMs, topSlow: perTaskThisTick }, 'scheduler tick exceeded overlap budget');
  } else if (lastTickMs > 5000) {
    // Only log at info for non-trivial ticks; most ticks are <100ms
    // because every task short-circuits immediately via its time gate.
    logger.info({ tickMs: lastTickMs, topSlow: perTaskThisTick.slice(0, 3) }, 'scheduler tick');
  }
}
