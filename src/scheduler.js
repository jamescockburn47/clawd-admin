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
import { checkConsolidateShadow } from './overnight/consolidate-shadow-task.js';
import { checkProbe } from './overnight/probe-task.js';
import { checkReport } from './overnight/report-task.js';
import { checkImprove } from './overnight/improve-task.js';
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
  return { todayStr, hours, minutes, now };
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
  };
}

async function runTask(name, fn) {
  try {
    await fn();
  } catch (err) {
    logger.error({ task: name, err: err.message }, 'scheduler task failed');
  }
}

async function runScheduler() {
  const { todayStr, hours, minutes } = getLondonTime();

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
  await runTask('groundTruth', () => checkGroundTruth(sendFn, todayStr, hours, minutes));
  await runTask('dailyBackup', () => checkDailyBackup(todayStr, hours));

  // Sync cache every 30 minutes (at :00 and :30) when EVO memory is online
  if (config.evoMemoryEnabled && isEvoOnline()) {
    if (minutes % 30 === 0 && lastCacheSyncMinute !== minutes) {
      lastCacheSyncMinute = minutes;
      syncCache().catch(() => {});
    }
  }

  // Keep EVO X2 tool model warm every 10 minutes
  if (config.evoToolEnabled) {
    if (minutes % 10 === 0) {
      keepEvoWarm().catch(() => {});
    }
  }
}
