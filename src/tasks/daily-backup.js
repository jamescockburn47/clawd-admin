// Task: 3 AM daily data backup

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cleanDocumentCache } from '../memory.js';
import { appendEvent } from '../overnight/events.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');

// State persistence — without this, getLastBackupDate() returns null after
// every bot restart and the dashboard shows "never" for a task that ran
// last night. Pattern matches src/tasks/briefing.js.
import { readFileSync as __readFileSync_lastBackupDate, writeFileSync as __writeFileSync_lastBackupDate, mkdirSync as __mkdirSync_lastBackupDate, existsSync as __existsSync_lastBackupDate } from 'node:fs';
import { join as __join_lastBackupDate, dirname as __dirname_lastBackupDate } from 'node:path';
const __STATE_FILE_lastBackupDate = __join_lastBackupDate('data', 'runtime', 'daily-backup-state.json');
let __persisted_lastBackupDate = {};
try {
  if (__existsSync_lastBackupDate(__STATE_FILE_lastBackupDate)) {
    __persisted_lastBackupDate = JSON.parse(__readFileSync_lastBackupDate(__STATE_FILE_lastBackupDate, 'utf-8'));
  }
} catch { /* intentional: corrupt file = treat as empty */ }
function __save_lastBackupDate() {
  try {
    const dir = __dirname_lastBackupDate(__STATE_FILE_lastBackupDate);
    if (!__existsSync_lastBackupDate(dir)) __mkdirSync_lastBackupDate(dir, { recursive: true });
    __writeFileSync_lastBackupDate(__STATE_FILE_lastBackupDate, JSON.stringify({ lastBackupDate: lastBackupDate }, null, 2));
  } catch { /* intentional: state-write failures must not cascade */ }
}

let lastBackupDate = __persisted_lastBackupDate.lastBackupDate || null;

/**
 * Run daily backup at 3 AM London time.
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkDailyBackup(todayStr, hours) {
  if (lastBackupDate === todayStr) return;
  if (hours !== 3) return;

  lastBackupDate = todayStr;
  __save_lastBackupDate();

  const backupDir = join(DATA_DIR, 'backups', todayStr);
  const filesToBackup = ['todos.json', 'soul.json', 'soul_history.json'];
  let count = 0;
  let errorSummary = null;

  try {
    await mkdir(backupDir, { recursive: true });

    for (const file of filesToBackup) {
      const src = join(DATA_DIR, file);
      if (existsSync(src)) {
        try {
          const data = await readFile(src);
          await writeFile(join(backupDir, file), data);
          count++;
        } catch (err) {
          logger.error({ file, err: err.message }, 'backup file failed');
        }
      }
    }

    // Clean old backups (keep last 7)
    try {
      const backupsRoot = join(DATA_DIR, 'backups');
      const dirs = (await readdir(backupsRoot)).sort();
      while (dirs.length > 7) {
        const old = dirs.shift();
        await rm(join(backupsRoot, old), { recursive: true, force: true });
      }
    } catch (err) { logger.warn({ err: err.message }, 'backup rotation failed'); }

    if (count > 0) {
      logger.info({ date: todayStr, files: count }, 'daily backup complete');
    }

    // Clean old document cache files (7-day TTL)
    try {
      cleanDocumentCache(7);
    } catch (err) { logger.warn({ err: err.message }, 'document cache cleanup failed'); }
  } catch (err) {
    errorSummary = err.message;
    logger.error({ err: err.message }, 'daily-backup failed');
  }

  // Event log: single summary event per night (success or failure).
  try {
    await appendEvent({
      stage: 'operations',
      phase: 'daily-backup',
      inputs: filesToBackup,
      outputs: errorSummary ? [] : [`backups/${todayStr}`],
      verdict: errorSummary ? 'failed' : 'ok',
      reason: errorSummary ?? `${count} files backed up to backups/${todayStr}`,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    }, { date: todayStr });
  } catch (err) {
    logger.warn({ err: err.message }, 'daily-backup: failed to write event');
  }
}

export function getLastBackupDate() { return lastBackupDate; }
