// Task: System knowledge refresh (2 AM)

import { refreshSystemKnowledge } from '../system-knowledge.js';
import { appendEvent } from '../overnight/events.js';
import config from '../config.js';
import logger from '../logger.js';

let lastKnowledgeRefreshDate = null;

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
