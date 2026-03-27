// src/session-repair.js — Auto-repair corrupted Baileys Signal sessions
// When Bad MAC or SessionError occurs repeatedly for a JID, deletes the
// corrupted session file so Baileys re-establishes a fresh session.

import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';

// Track failure counts per sender JID: Map<jid, { count, lastSeen }>
const failureCounts = new Map();

// After this many failures within the window, repair the session
const REPAIR_THRESHOLD = 3;
// Reset failure count after this many ms of no failures
const RESET_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Record a decryption failure for a sender and auto-repair if threshold reached.
 * @param {string} senderJid - The JID that failed decryption (e.g. "216131344289942")
 * @param {string} errorType - "BadMAC" or "SessionError"
 */
export function recordDecryptionFailure(senderJid, errorType) {
  if (!senderJid) return;

  // Extract the numeric part of the JID for session file lookup
  const numericJid = senderJid.replace(/@.*$/, '');
  if (!numericJid) return;

  const now = Date.now();
  const existing = failureCounts.get(numericJid) || { count: 0, lastSeen: 0 };

  // Reset if outside the window
  if (now - existing.lastSeen > RESET_WINDOW_MS) {
    existing.count = 0;
  }

  existing.count++;
  existing.lastSeen = now;
  failureCounts.set(numericJid, existing);

  if (existing.count >= REPAIR_THRESHOLD) {
    repairSession(numericJid, errorType);
    failureCounts.delete(numericJid);
  }
}

/**
 * Delete corrupted session files for a JID, forcing Baileys to re-establish.
 */
function repairSession(numericJid, reason) {
  const authDir = config.authStatePath;
  let deleted = 0;

  // Session files follow pattern: session-{numericJid}.{device}.json
  // Check device IDs 0 through 99 (realistically 0-10)
  for (let device = 0; device < 100; device++) {
    const fileName = `session-${numericJid}.${device}.json`;
    const filePath = join(authDir, fileName);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
        deleted++;
      } catch (err) {
        logger.warn({ err: err.message, file: fileName }, 'failed to delete session file');
      }
    }
  }

  if (deleted > 0) {
    logger.info({ jid: numericJid, deleted, reason }, 'auto-repaired corrupted session — deleted session files');
  }
}
