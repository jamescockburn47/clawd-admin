// Task: System knowledge refresh (2 AM)

import { refreshSystemKnowledge } from '../system-knowledge.js';
import { appendEvent } from '../overnight/events.js';
import config from '../config.js';
import logger from '../logger.js';

// State persistence — without this, getLastKnowledgeRefreshDate() returns null after
// every bot restart and the dashboard shows "never" for a task that ran
// last night. Pattern matches src/tasks/briefing.js.
import { readFileSync as __readFileSync_lastKnowledgeRefreshDate, writeFileSync as __writeFileSync_lastKnowledgeRefreshDate, mkdirSync as __mkdirSync_lastKnowledgeRefreshDate, existsSync as __existsSync_lastKnowledgeRefreshDate } from 'node:fs';
import { join as __join_lastKnowledgeRefreshDate, dirname as __dirname_lastKnowledgeRefreshDate } from 'node:path';
const __STATE_FILE_lastKnowledgeRefreshDate = __join_lastKnowledgeRefreshDate('data', 'runtime', 'system-refresh-state.json');
let __persisted_lastKnowledgeRefreshDate = {};
try {
  if (__existsSync_lastKnowledgeRefreshDate(__STATE_FILE_lastKnowledgeRefreshDate)) {
    __persisted_lastKnowledgeRefreshDate = JSON.parse(__readFileSync_lastKnowledgeRefreshDate(__STATE_FILE_lastKnowledgeRefreshDate, 'utf-8'));
  }
} catch { /* intentional: corrupt file = treat as empty */ }
function __save_lastKnowledgeRefreshDate() {
  try {
    const dir = __dirname_lastKnowledgeRefreshDate(__STATE_FILE_lastKnowledgeRefreshDate);
    if (!__existsSync_lastKnowledgeRefreshDate(dir)) __mkdirSync_lastKnowledgeRefreshDate(dir, { recursive: true });
    __writeFileSync_lastKnowledgeRefreshDate(__STATE_FILE_lastKnowledgeRefreshDate, JSON.stringify({ lastKnowledgeRefreshDate: lastKnowledgeRefreshDate }, null, 2));
  } catch { /* intentional: state-write failures must not cascade */ }
}

let lastKnowledgeRefreshDate = __persisted_lastKnowledgeRefreshDate.lastKnowledgeRefreshDate || null;

/**
 * Refresh system knowledge at 2 AM London time.
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkSystemKnowledgeRefresh(todayStr, hours) {
  if (!config.evoMemoryEnabled) return;

  if (lastKnowledgeRefreshDate === todayStr) return;
  if (hours !== 2) return;

  lastKnowledgeRefreshDate = todayStr;
  __save_lastKnowledgeRefreshDate();

  let result = null;
  let errorSummary = null;

  try {
    logger.info('system-knowledge: starting nightly refresh');
    result = await refreshSystemKnowledge();
    if (result.refreshed) {
      logger.info({ deleted: result.deleted, seeded: result.seeded, elapsed: result.elapsed }, 'system-knowledge: nightly refresh complete');
    }
  } catch (err) {
    errorSummary = err.message;
    logger.error({ err: err.message }, 'system-knowledge: nightly refresh failed');
  }

  // Event log: one summary event per night.
  try {
    let reason;
    if (errorSummary) {
      reason = errorSummary;
    } else if (result?.refreshed) {
      reason = `${result.seeded ?? 0} files seeded, ${result.deleted ?? 0} stale entries removed`;
    } else {
      reason = 'no refresh needed (knowledge already current)';
    }
    await appendEvent({
      stage: 'operations',
      phase: 'system-refresh',
      inputs: ['data/system-knowledge/'],
      outputs: errorSummary ? [] : ['evo-memory:system-knowledge'],
      verdict: errorSummary ? 'failed' : 'ok',
      reason,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    }, { date: todayStr });
  } catch (err) {
    logger.warn({ err: err.message }, 'system-refresh: failed to write event');
  }
}

export function getLastKnowledgeRefreshDate() { return lastKnowledgeRefreshDate; }
