// Task: Self-improvement cycle trigger (1 AM)
// Also includes overnight extraction (2 AM), overnight report (5:30 AM),
// and project deep think (11 PM).

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runImprovementCycle } from '../self-improve/cycle.js';
import { extractFromConversation, isEvoOnline } from '../memory.js';
import { runProjectDeepThink } from '../project-thinker.js';
import { sendOvernightReport } from '../overnight-report.js';
import config from '../config.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let lastSelfImproveDate = null;
let lastExtractionDate = null;
let lastReportDate = null;
let lastProjectThinkDate = null;

/**
 * Run self-improvement cycle at 1 AM London time.
 * @param {Function} sendFn - WhatsApp send function
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkSelfImprovement(sendFn, todayStr, hours) {
  if (!config.evoToolEnabled) return;

  if (lastSelfImproveDate === todayStr) return;
  if (hours !== 1) return;

  lastSelfImproveDate = todayStr;

  try {
    logger.info('self-improve: starting nightly cycle');
    await runImprovementCycle(sendFn);
  } catch (err) {
    logger.error({ err: err.message }, 'self-improve: nightly cycle failed');
  }
}

/**
 * Run overnight batch extraction at 2 AM London time.
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkOvernightExtraction(todayStr, hours) {
  if (!config.evoMemoryEnabled || !isEvoOnline()) return;

  if (lastExtractionDate === todayStr) return;
  if (hours !== 2) return;

  lastExtractionDate = todayStr;

  try {
    // Read conversation logs from yesterday
    const yesterday = new Date(todayStr + 'T12:00:00');
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];

    const logDir = join(__dirname, '..', '..', 'data', 'conversation-logs');
    if (!existsSync(logDir)) return;

    const files = (await readdir(logDir)).filter(f => f.startsWith(yStr) && f.endsWith('.jsonl'));
    if (files.length === 0) return;

    let totalExtracted = 0;

    for (const file of files) {
      try {
        const content = await readFile(join(logDir, file), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        if (lines.length < 2) continue;

        // Build conversation text from log entries
        const messages = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        const convText = messages.map(m =>
          `${m.sender || (m.isBot ? 'Clawd' : 'User')}: ${m.text}`
        ).join('\n');

        if (convText.length < 50) continue;

        const result = await extractFromConversation(convText, `conversation_${yStr}`);
        if (result.extracted) totalExtracted += result.extracted.length;
      } catch (err) {
        logger.error({ file, err: err.message }, 'extraction from log failed');
      }
    }

    if (totalExtracted > 0) {
      logger.info({ date: yStr, extracted: totalExtracted }, 'overnight extraction complete');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'overnight extraction failed');
  }
}

/**
 * Send overnight report at 5:30 AM London time.
 * @param {Function} sendFn - WhatsApp send function
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 * @param {number} minutes - Current London minute
 */
export async function checkOvernightReport(sendFn, todayStr, hours, minutes) {
  if (lastReportDate === todayStr) return;
  if (hours !== 5 || minutes < 30) return;

  lastReportDate = todayStr;

  try {
    logger.info('overnight-report: starting');
    await sendOvernightReport(sendFn);
  } catch (err) {
    logger.error({ err: err.message }, 'overnight-report: failed');
  }
}

/**
 * Run project deep think at 11 PM London time.
 * @param {Function} sendFn - WhatsApp send function
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkProjectDeepThink(sendFn, todayStr, hours) {
  if (lastProjectThinkDate === todayStr) return;
  if (hours !== 23) return;

  lastProjectThinkDate = todayStr;

  try {
    logger.info('project-thinker: starting overnight deep think');
    await runProjectDeepThink(sendFn);
  } catch (err) {
    logger.error({ err: err.message }, 'project-thinker: overnight cycle failed');
  }
}

export function getLastSelfImproveDate() { return lastSelfImproveDate; }
export function getLastExtractionDate() { return lastExtractionDate; }
export function getLastReportDate() { return lastReportDate; }
export function getLastProjectThinkDate() { return lastProjectThinkDate; }
