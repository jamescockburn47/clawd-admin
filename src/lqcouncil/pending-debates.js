// src/lqcouncil/pending-debates.js — short-lived proposal store keyed by
// confirm_id. A debate proposal sits here between `lqc_start_debate`
// (which drafts a proposal with topic + auto-picked bots) and
// `lqc_confirm_debate` (which fires POST /debates). If confirmation
// doesn't arrive within EXPIRY_MS, the entry self-evicts on lookup.

import { randomBytes } from 'node:crypto';

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, {topic: string, botIds: string[], sourceJid: string, senderJid: string, createdAt: number, expiresAt: number}>} */
const _pending = new Map();

function freshId() {
  return randomBytes(4).toString('hex');
}

/**
 * Store a proposal. Returns the generated confirm_id so the caller can
 * surface it in the WhatsApp reply for the user to paste back.
 */
export function storeProposal({ topic, botIds, sourceJid, senderJid }) {
  const confirmId = freshId();
  _pending.set(confirmId, {
    topic,
    botIds: Array.isArray(botIds) ? [...botIds] : [],
    sourceJid: sourceJid || null,
    senderJid: senderJid || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + EXPIRY_MS,
  });
  return confirmId;
}

/**
 * Look up and consume a proposal. Single-use — a successful lookup
 * deletes the entry so a confirm can't be replayed. Expired entries
 * also delete and return null.
 */
export function consumeProposal(confirmId) {
  const entry = _pending.get(confirmId);
  if (!entry) return null;
  _pending.delete(confirmId);
  if (Date.now() > entry.expiresAt) return null;
  return entry;
}

/** Peek without consuming — for diagnostics/tests. */
export function peekProposal(confirmId) {
  const entry = _pending.get(confirmId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _pending.delete(confirmId);
    return null;
  }
  return entry;
}

/** Test-only: clear all pending proposals. */
export function clearAllProposals() {
  _pending.clear();
}

export { EXPIRY_MS as PENDING_DEBATE_EXPIRY_MS };
