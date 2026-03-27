// Task: 3 AM daily data backup

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cleanDocumentCache } from '../memory.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');

let lastBackupDate = null;

/**
 * Run daily backup at 3 AM London time.
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkDailyBackup(todayStr, hours) {
  if (lastBackupDate === todayStr) return;
  if (hours !== 3) return;

  lastBackupDate = todayStr;

  const backupDir = join(DATA_DIR, 'backups', todayStr);
  await mkdir(backupDir, { recursive: true });

  const filesToBackup = ['todos.json', 'soul.json', 'soul_history.json'];
  let count = 0;

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
  } catch {}

  if (count > 0) {
    logger.info({ date: todayStr, files: count }, 'daily backup complete');
  }

  // Clean old document cache files (7-day TTL)
  try {
    cleanDocumentCache(7);
  } catch {}
}

export function getLastBackupDate() { return lastBackupDate; }
