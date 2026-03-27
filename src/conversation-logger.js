// Conversation logger — JSONL per-group conversation logging

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const CONV_LOG_DIR = join('data', 'conversation-logs');

// Ensure directory exists
mkdirSync(CONV_LOG_DIR, { recursive: true });

/**
 * Log conversation messages to a per-group JSONL file.
 * @param {string} chatJid - WhatsApp chat JID
 * @param {Array<{senderName: string, text: string, isBot: boolean}>} messages
 */
export function logConversation(chatJid, messages) {
  const date = new Date().toISOString().split('T')[0];
  const filename = `${date}_${chatJid.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`;
  const filepath = join(CONV_LOG_DIR, filename);

  const lines = messages.map(m => JSON.stringify({
    timestamp: new Date().toISOString(),
    sender: m.senderName,
    text: m.text,
    isBot: m.isBot,
  }));

  try {
    const existing = existsSync(filepath) ? readFileSync(filepath, 'utf-8') : '';
    writeFileSync(filepath, existing + lines.join('\n') + '\n');
  } catch (err) {
    logger.error({ err: err.message }, 'conversation log write failed');
  }
}
