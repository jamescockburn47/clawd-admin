// Interaction log — rich append-only JSONL capturing full request/response pairs,
// quality signals, and human feedback for evolution pipeline.
//
// Unlike audit.js (tool-level), this logs at the *conversation* level:
// what was asked, how it was routed, what was answered, how long it took,
// and eventually whether the user approved or corrected it.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import logger from './logger.js';

const DATA_DIR = join('data');
const LOG_FILE = join(DATA_DIR, 'interactions.jsonl');
const FEEDBACK_FILE = join(DATA_DIR, 'feedback.jsonl');

// In-memory ring buffer: maps sent WhatsApp message IDs to interaction IDs
// so we can correlate reactions (thumbs up/down) back to the interaction
const MESSAGE_MAP_SIZE = 200;
const messageToInteraction = new Map(); // msgId → { interactionId, timestamp }

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function genId() {
  return randomBytes(8).toString('hex');
}

/**
 * Log a complete interaction (request → routing → response).
 * Returns the interaction ID for later feedback correlation.
 */
export function logInteraction({
  sender,         // { name, jid }
  source,         // 'whatsapp' | 'voice' | 'dashboard'
  input,          // { text, hadImage }
  routing,        // { category, model, forceClaude, reason, classifySource }
  toolsCalled,    // [{ name, success, latencyMs }]
  response,       // { text, chars, tokens }
  latencyMs,      // total time from receipt to response sent
  messageIds,     // array of sent WhatsApp message IDs (for reaction correlation)
}) {
  const id = genId();
  const entry = {
    id,
    ts: new Date().toISOString(),
    sender: sender || {},
    source: source || 'whatsapp',
    input: input || {},
    routing: routing || {},
    toolsCalled: toolsCalled || [],
    response: {
      chars: response?.chars || response?.text?.length || 0,
      tokens: response?.tokens || null,
      // Store first 500 chars of response for analysis without bloating logs
      preview: response?.text ? response.text.slice(0, 500) : null,
    },
    latencyMs: latencyMs || null,
  };

  try {
    ensureDir();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.warn({ err: err.message }, 'interaction log write failed');
  }

  // Register message IDs for reaction correlation
  if (messageIds && messageIds.length > 0) {
    for (const msgId of messageIds) {
      messageToInteraction.set(msgId, { interactionId: id, timestamp: Date.now() });
    }
    // Evict old entries if buffer is full
    while (messageToInteraction.size > MESSAGE_MAP_SIZE) {
      const oldest = messageToInteraction.keys().next().value;
      messageToInteraction.delete(oldest);
    }
  }

  return id;
}

/**
 * Log feedback (reaction, correction, explicit approval/rejection).
 */
export function logFeedback({
  interactionId,  // links back to interaction (null if standalone correction)
  type,           // 'reaction' | 'correction' | 'explicit' | 'voice_correction'
  signal,         // 'positive' | 'negative' | 'neutral'
  detail,         // reaction emoji, correction text, etc.
  sender,         // { name, jid }
}) {
  const entry = {
    ts: new Date().toISOString(),
    interactionId: interactionId || null,
    type,
    signal,
    detail: detail || null,
    sender: sender || {},
  };

  try {
    ensureDir();
    appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
    logger.info({ type, signal, interactionId }, 'feedback logged');
  } catch (err) {
    logger.warn({ err: err.message }, 'feedback log write failed');
  }
}

/**
 * Handle a WhatsApp reaction — look up the interaction and log feedback.
 * Returns true if the reaction was correlated to an interaction.
 */
export function handleReaction(messageId, emoji, senderJid, senderName) {
  const mapping = messageToInteraction.get(messageId);

  // Classify the emoji
  const positive = new Set(['👍', '❤️', '😊', '🙏', '✅', '💯', '🔥', '👏', '⭐', '💪']);
  const negative = new Set(['👎', '❌', '😕', '🤦', '💩', '😡', '🚫', '⚠️']);
  let signal = 'neutral';
  if (positive.has(emoji)) signal = 'positive';
  else if (negative.has(emoji)) signal = 'negative';

  logFeedback({
    interactionId: mapping?.interactionId || null,
    type: 'reaction',
    signal,
    detail: emoji,
    sender: { name: senderName, jid: senderJid },
  });

  if (mapping) {
    logger.info({ emoji, signal, interactionId: mapping.interactionId }, 'reaction correlated to interaction');
  } else {
    logger.debug({ emoji, messageId }, 'reaction on unknown message (not in buffer)');
  }

  return !!mapping;
}

// Correction patterns — detect when user is correcting Clawd
const CORRECTION_PATTERNS = [
  /\bthat(?:'s| is| was) (?:wrong|incorrect|not right|not what I (?:asked|meant|said))\b/i,
  /\bno,?\s+(?:i (?:said|meant|asked)|that's not)\b/i,
  /\byou (?:got it wrong|misunderstood|didn't (?:understand|listen))\b/i,
  /\bwrong answer\b/i,
  /\btry again\b/i,
  /\bI didn't (?:ask|say|mean) that\b/i,
];

/**
 * Check if a message is a correction of the previous response.
 * Returns true if it looks like negative feedback.
 */
export function isCorrection(text) {
  if (!text) return false;
  return CORRECTION_PATTERNS.some(p => p.test(text));
}

/**
 * Read recent interactions for the evolution pipeline.
 * Returns last N entries from the JSONL log.
 */
export function getRecentInteractions(limit = 100) {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n');
    return lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read recent feedback entries.
 */
export function getRecentFeedback(limit = 100) {
  try {
    if (!existsSync(FEEDBACK_FILE)) return [];
    const lines = readFileSync(FEEDBACK_FILE, 'utf-8').trim().split('\n');
    return lines.slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get quality summary for the evolution pipeline.
 */
export function getQualitySummary(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const interactions = getRecentInteractions(1000).filter(i => i.ts >= cutoff);
  const feedback = getRecentFeedback(500).filter(f => f.ts >= cutoff);

  const positive = feedback.filter(f => f.signal === 'positive').length;
  const negative = feedback.filter(f => f.signal === 'negative').length;
  const corrections = feedback.filter(f => f.type === 'correction').length;

  // Route breakdown
  const routes = {};
  for (const i of interactions) {
    const model = i.routing?.model || 'unknown';
    routes[model] = (routes[model] || 0) + 1;
  }

  // Average latency by model
  const latencies = {};
  for (const i of interactions) {
    const model = i.routing?.model || 'unknown';
    if (i.latencyMs) {
      if (!latencies[model]) latencies[model] = [];
      latencies[model].push(i.latencyMs);
    }
  }
  const avgLatency = {};
  for (const [model, vals] of Object.entries(latencies)) {
    avgLatency[model] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Tool failure rate
  const allTools = interactions.flatMap(i => i.toolsCalled || []);
  const toolFails = allTools.filter(t => !t.success).length;

  return {
    period: `${days}d`,
    interactions: interactions.length,
    feedback: { positive, negative, corrections, total: feedback.length },
    approvalRate: positive + negative > 0
      ? Math.round((positive / (positive + negative)) * 100) + '%'
      : 'no feedback',
    routes,
    avgLatency,
    toolFailRate: allTools.length > 0
      ? Math.round((toolFails / allTools.length) * 100) + '%'
      : 'no tools',
  };
}
