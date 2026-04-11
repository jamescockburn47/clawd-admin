// src/tasks/sovren-contribution-cross-reference.js
//
// Overnight task: walk recent SOVREN git commits, identify which files
// changed, look up affected methodology contributions in the contribution
// index, and emit an event into the morning report event log.
//
// Runs in the OPERATIONS stage of the overnight pipeline (see
// docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md).

import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import logger from '../logger.js';
import { ContributionStore } from '../sovren/contribution-store.js';

const SOVREN_REPO_PATH = '/home/james/projects/sovren';
const EVENT_LOG_DIR = '/home/james/clawdbot/data/overnight';

/** Get the SOVREN files changed in the last N hours of git history. */
function getRecentChangedFiles(hours = 30) {
  try {
    const since = `${hours} hours ago`;
    const out = execSync(
      `git -C "${SOVREN_REPO_PATH}" log --since="${since}" --name-only --pretty=format:`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const files = out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return Array.from(new Set(files));
  } catch (err) {
    logger.warn({ err: err.message }, 'sovren cross-reference: git log failed');
    return [];
  }
}

/** Append a structured event to today's overnight event log. */
async function appendEvent(event) {
  await fs.mkdir(EVENT_LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const eventLogPath = path.join(EVENT_LOG_DIR, `events-${date}.jsonl`);
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(eventLogPath, line);
}

/** Main entry point. */
export async function runSovrenCrossReference() {
  const startedAt = new Date().toISOString();
  const store = new ContributionStore();

  let changedFiles = [];
  try {
    changedFiles = getRecentChangedFiles(30);
  } catch (err) {
    logger.warn({ err: err.message }, 'sovren cross-reference: changed files lookup failed');
  }

  let index;
  try {
    index = await store.loadIndex();
  } catch (err) {
    logger.warn({ err: err.message }, 'sovren cross-reference: index load failed');
    await appendEvent({
      stage: 'operations',
      type: 'sovren_contributions_cross_reference',
      timestamp: startedAt,
      verdict: 'failed',
      reason: 'index_load_failed',
      changedFiles,
    });
    return;
  }

  // For each changed file, find any contributions that list it (or a parent
  // directory) in their `affects` array.
  const affected = [];
  for (const entry of index.contributions) {
    if (entry.status === 'rejected' || entry.status === 'superseded') continue;
    for (const codePath of entry.affects) {
      const hit = changedFiles.find(
        (f) => f === codePath || f.startsWith(`${codePath}/`) || codePath.startsWith(`${f}/`),
      );
      if (hit) {
        affected.push({
          id: entry.id,
          contributor: entry.contributor,
          description: entry.shortDescription,
          fileChanges: [hit],
        });
        break;
      }
    }
  }

  await appendEvent({
    stage: 'operations',
    type: 'sovren_contributions_cross_reference',
    timestamp: startedAt,
    verdict: 'completed',
    changedFiles,
    affectedContributions: affected,
    totalContributions: index.contributions.length,
  });

  logger.info(
    {
      changedFiles: changedFiles.length,
      affected: affected.length,
      totalContributions: index.contributions.length,
    },
    'sovren cross-reference task completed',
  );
}

// Allow running as a standalone script: node src/tasks/sovren-contribution-cross-reference.js
if (import.meta.url === `file://${process.argv[1]}`) {
  runSovrenCrossReference()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('sovren cross-reference failed:', err);
      process.exit(1);
    });
}
