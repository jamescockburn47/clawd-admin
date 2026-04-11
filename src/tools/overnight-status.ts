// src/tools/overnight-status.ts — Query last night's overnight job outcomes
//
// Post-Phase-5: reads the new event log (data/overnight/events-<date>.jsonl)
// and returns a concise summary of what ran overnight. Replaces the old
// implementation that read from data/forge/reports/ and data/evolution-tasks.json
// (both retired).

import logger from '../logger.js';
import { buildAndRenderReport } from '../overnight/report.js';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

interface StatusInput {
  date?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..', '..');
const OVERNIGHT_DIR = join(REPO_DIR, 'data', 'overnight');

/** Return a concise plain-text summary of what ran overnight. */
export async function overnightStatus({ date }: StatusInput = {}): Promise<string> {
  const dateStr = date || todayLondon();

  try {
    const { report, text } = await buildAndRenderReport({
      date: dateStr,
      overnightDir: OVERNIGHT_DIR,
    });
    logger.info(
      { date: dateStr, events: report.events.length, errors: report.errors.length },
      'overnight_status tool invoked',
    );
    return text;
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ date: dateStr, err: message }, 'overnight_status failed');
    return `*Overnight jobs for ${dateStr}:* unable to read event log — ${message}`;
  }
}

function todayLondon(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}
