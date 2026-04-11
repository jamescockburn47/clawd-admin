import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from '../logger.js';

const LOG_FILE = join('data', 'agency-decisions.jsonl');

function ensureDir() {
  const dir = join('data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function logAgencyDecision(entry) {
  try {
    ensureDir();
    appendFileSync(
      LOG_FILE,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
      }) + '\n',
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'agency decision log write failed');
  }
}
