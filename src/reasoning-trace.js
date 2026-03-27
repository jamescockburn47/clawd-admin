// src/reasoning-trace.js — Structured reasoning trace logger
// Persists routing, engagement, model selection, and planning decisions
// to data/reasoning-traces.jsonl for overnight analysis and debugging.
import { appendFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const TRACE_FILE = join('data', 'reasoning-traces.jsonl');

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
 *   - toolsCalled: string[]
 *   - totalTimeMs: number
 */
export function logReasoningTrace(trace) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...trace,
  };
  try {
    appendFileSync(TRACE_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Non-fatal — trace logging should never break message handling
    logger.warn({ err: err.message }, 'reasoning trace write failed');
  }
}
