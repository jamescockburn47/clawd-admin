// Scheduler — 60-second interval, dispatches all scheduled tasks.
// Each task is isolated: one failing task doesn't block others.

import { checkEvoHealth, isEvoOnline, syncCache } from './memory.js';
import { keepEvoWarm } from './evo-llm.js';
import { getEvoStatus } from './memory.js';
import { checkTodoReminders } from './tasks/todo-reminders.js';
import { checkSideGigMeetings } from './tasks/meeting-alerts.js';
import { checkMorningBriefing, checkWeeklyReview, getLastBriefingDate, getLastReviewDate } from './tasks/briefing.js';
import { checkDailyBackup, getLastBackupDate } from './tasks/daily-backup.js';
import { checkSystemKnowledgeRefresh, getLastKnowledgeRefreshDate } from './tasks/system-refresh.js';
import { checkEvolutionTasks } from './tasks/evolution-dispatch.js';
import {
  checkSelfImprovement, checkOvernightExtraction, checkOvernightReport,
  checkProjectDeepThink, getLastSelfImproveDate, getLastExtractionDate,
  getLastReportDate, getLastProjectThinkDate,
} from './tasks/improvement-cycle.js';
import { checkTraceAnalysis, getLastAnalysisDate } from './tasks/trace-analyser.js';
import { checkWeeklyRetrospective, getLastRetroDate } from './tasks/weekly-retrospective.js';
import { checkOvernightEvolution, getLastOvernightEvoDate } from './tasks/overnight-to-evolution.js';
import { checkGroundTruth, getLastHarvestDate } from './tasks/ground-truth.js';
import { checkForge, getLastForgeDate } from './tasks/forge-orchestrator.js';
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
    diary: { enabled: !!config.dreamModeEnabled, lastRun: getLastExtractionDate() },
    selfImprove: { enabled: !!config.evoToolEnabled, lastRun: getLastSelfImproveDate() },
    knowledgeRefresh: { enabled: !!config.evoMemoryEnabled, lastRun: getLastKnowledgeRefreshDate() },
    projectDeepThink: { enabled: true, lastRun: getLastProjectThinkDate() },
    overnightReport: { enabled: true, lastRun: getLastReportDate() },
    traceAnalysis: { enabled: true, lastRun: getLastAnalysisDate() },
    weeklyRetrospective: { enabled: true, lastRun: getLastRetroDate() },
    overnightEvolution: { enabled: true, lastRun: getLastOvernightEvoDate() },
    forge: { enabled: true, lastRun: getLastForgeDate() },
    backup: { lastRun: getLastBackupDate() },
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

  await runTask('todoReminders', () => checkTodoReminders(sendFn));
  await runTask('sideGigMeetings', () => checkSideGigMeetings(sendFn));
  await runTask('morningBriefing', () => checkMorningBriefing(sendFn, todayStr, hours, minutes));
  await runTask('weeklyReview', () => checkWeeklyReview(sendFn, todayStr, hours));
  await runTask('overnightExtraction', () => checkOvernightExtraction(todayStr, hours));
  await runTask('selfImprovement', () => checkSelfImprovement(sendFn, todayStr, hours));
  await runTask('systemKnowledgeRefresh', () => checkSystemKnowledgeRefresh(todayStr, hours));
  await runTask('projectDeepThink', () => checkProjectDeepThink(sendFn, todayStr, hours));
  await runTask('traceAnalysis', () => checkTraceAnalysis(sendFn, todayStr, hours));
  await runTask('groundTruth', () => checkGroundTruth(sendFn, todayStr, hours, minutes));
  await runTask('weeklyRetrospective', () => checkWeeklyRetrospective(sendFn, todayStr, hours));
  await runTask('overnightReport', () => checkOvernightReport(sendFn, todayStr, hours, minutes));
  await runTask('overnightEvolution', () => checkOvernightEvolution(sendFn, todayStr, hours));
  await runTask('forge', () => checkForge(sendFn, todayStr, hours, minutes));
  await runTask('evolutionTasks', () => checkEvolutionTasks(sendFn));
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
