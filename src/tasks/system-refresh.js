// Task: System knowledge refresh (2 AM)

import { refreshSystemKnowledge } from '../system-knowledge.js';
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

  try {
    logger.info('system-knowledge: starting nightly refresh');
    const result = await refreshSystemKnowledge();
    if (result.refreshed) {
      logger.info({ deleted: result.deleted, seeded: result.seeded, elapsed: result.elapsed }, 'system-knowledge: nightly refresh complete');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'system-knowledge: nightly refresh failed');
  }
}

export function getLastKnowledgeRefreshDate() { return lastKnowledgeRefreshDate; }
