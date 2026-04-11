// src/reasoning-trace.js — Structured reasoning trace logger
// Persists routing, engagement, model selection, and planning decisions
// to data/reasoning-traces.jsonl for overnight analysis and debugging.
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const TRACE_FILE = join('data', 'reasoning-traces.jsonl');
// Approximation only: overnight reporting samples the recent tail of the trace
// log for a cheap cross-check, not a guaranteed full-day exhaustive scan.
const PARTICIPATION_CROSSCHECK_TRACE_TAIL_LIMIT = 8000;

/**
 * Log a complete reasoning trace for one message processing cycle.
 * Called from claude.js after the response is generated.
 *
 * @param {object} trace - Structured trace data:
 *   - messageId: WhatsApp message ID (if available)
 *   - chatId: group JID or DM JID
 *   - sender: sender JID
 *   - engagement: { decision, reason, confidence, timeMs } or null (DMs)
 *   - routing: { category, layer, needsPlan, planReason, forceClaude, writeIntent, confidence, timeMs }
 *   - model: { selected, reason, qualityGate }
 *   - plan: plan object or null
 *   - participation: optional { posture, replyTarget, followUpWindowOpen, followUpTurnIndex, plannedRole }
 *   - toolsCalled: string[]
 *   - totalTimeMs: number
 */
export function logReasoningTrace(trace) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...trace,
    participation: trace.participation ?? null,
  };
  try {
    appendFileSync(TRACE_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Non-fatal — trace logging should never break message handling
    logger.warn({ err: err.message }, 'reasoning trace write failed');
  }
}

/**
 * Count reasoning trace lines for a UTC calendar day that include participation fields.
 * Used by the overnight participation summary as a labeled cross-check.
 * This is a recent-tail approximation, not an exact full-file day scan.
 */
export function countParticipationTaggedTracesOnDate(isoDate, baseDir = '.') {
  try {
    const traceFile = join(baseDir, TRACE_FILE);
    if (!existsSync(traceFile)) return 0;
    const raw = readFileSync(traceFile, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    let n = 0;
    for (const line of lines.slice(-PARTICIPATION_CROSSCHECK_TRACE_TAIL_LIMIT)) {
      try {
        const o = JSON.parse(line);
        if (typeof o.timestamp === 'string' && o.timestamp.startsWith(isoDate) && o.participation) {
          n += 1;
        }
      } catch {
        // intentional: skip malformed lines
      }
    }
    return n;
  } catch {
    return 0;
  }
}
