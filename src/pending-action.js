// src/pending-action.js — Stores pending multi-step actions per chat
// Used by devil's advocate and summary modes, which need a topic selection
// step before execution.
import logger from './logger.js';

// Map<chatJid, PendingAction>
const _pending = new Map();

const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @typedef {Object} PendingAction
 * @property {string} mode - 'critique' or 'summary'
 * @property {Array} topics - Parsed topic list from segmentation
 * @property {string} transcript - Full message transcript for execution
 * @property {number} expiresAt - Timestamp when this pending action expires
 */

/**
 * Store a pending action for a chat.
 * @param {string} chatJid
 * @param {string} mode - 'critique' or 'summary'
 * @param {Array} topics - Parsed topic list
 * @param {string} transcript - Full transcript for later execution
 */
export function setPendingAction(chatJid, mode, topics, transcript) {
  _pending.set(chatJid, {
    mode,
    topics,
    transcript,
    expiresAt: Date.now() + EXPIRY_MS,
  });
  logger.info({ chatJid, mode, topicCount: topics.length }, 'pending-action: stored');
}

/**
 * Get the pending action for a chat, if it hasn't expired.
 * @param {string} chatJid
 * @returns {PendingAction|null}
 */
export function getPendingAction(chatJid) {
  const action = _pending.get(chatJid);
  if (!action) return null;
  if (Date.now() > action.expiresAt) {
    _pending.delete(chatJid);
    return null;
  }
  return action;
}

/**
 * Clear the pending action for a chat.
 * @param {string} chatJid
 */
export function clearPendingAction(chatJid) {
  _pending.delete(chatJid);
}

/**
 * Parse a user's topic selection from their reply.
 * Handles: "1", "1 and 3", "1, 3", "all", "1 2 3", "1+3"
 * Returns null if the message doesn't look like a topic selection.
 * @param {string} text
 * @param {number} maxTopic - Highest valid topic number
 * @returns {number[]|'all'|null}
 */
export function parseTopicSelection(text, maxTopic) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // "all" or "all of them" etc
  if (/^all\b/.test(lower) || lower === 'everything') return 'all';

  // Extract numbers from the text
  const numbers = [...lower.matchAll(/\d+/g)].map(m => parseInt(m[0]));
  if (numbers.length === 0) return null;

  // Validate all numbers are in range
  const valid = numbers.filter(n => n >= 1 && n <= maxTopic);
  if (valid.length === 0) return null;

  // Deduplicate and sort
  return [...new Set(valid)].sort((a, b) => a - b);
}
