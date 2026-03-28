// src/topic-scan.js — Topic segmentation for group conversations
// Reads recent group messages and clusters them into distinct topics.
// Shared infrastructure for devil's advocate mode and summary mode.
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const CONV_LOG_DIR = join('data', 'conversation-logs');
const DEFAULT_MESSAGE_COUNT = 50;

/**
 * Read the last N messages from a group's conversation logs.
 * Reads today's log and yesterday's if needed to hit the count.
 * @param {string} chatJid - Group JID
 * @param {number} count - Number of messages to retrieve
 * @returns {Array<{timestamp: string, sender: string, text: string, isBot: boolean}>}
 */
export function getRecentGroupMessages(chatJid, count = DEFAULT_MESSAGE_COUNT) {
  const sanitised = chatJid.replace(/[^a-zA-Z0-9]/g, '_');
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const messages = [];

  // Try today first, then yesterday if we need more
  for (const date of [today, yesterday]) {
    const filename = `${date}_${sanitised}.jsonl`;
    const filepath = join(CONV_LOG_DIR, filename);
    if (!existsSync(filepath)) continue;

    try {
      const lines = readFileSync(filepath, 'utf-8')
        .split('\n')
        .filter(line => line.trim());

      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
    } catch (err) {
      logger.warn({ err: err.message, filepath }, 'topic-scan: failed to read log');
    }
  }

  // Return last N messages, chronological order
  return messages.slice(-count);
}

/**
 * Format messages into a readable transcript for the LLM.
 * @param {Array} messages
 * @returns {string}
 */
export function formatTranscript(messages) {
  return messages.map((m, i) => {
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    const prefix = m.isBot ? 'Clawd' : m.sender;
    return `[${time}] ${prefix}: ${m.text}`;
  }).join('\n');
}

/**
 * Build the topic segmentation prompt.
 * @param {string} transcript - Formatted conversation transcript
 * @returns {string}
 */
export function buildSegmentationPrompt(transcript) {
  return `Analyse this group conversation and separate it into distinct topics. Each topic is a coherent thread of discussion — a subject the group talked about.

Rules:
- Merge closely related exchanges into one topic (don't over-split)
- Give each topic a short, descriptive label (5-10 words max)
- Order by most recent first
- If there's only one topic, return just that one
- Ignore greetings, bot commands, and meta-chat (e.g. "shut up clawd")

Return ONLY a numbered list in this exact format:
1. [Topic label] — [1-sentence summary of what was discussed]
2. [Topic label] — [1-sentence summary]
...

Conversation:
${transcript}`;
}

/**
 * Parse the LLM's numbered topic list into structured data.
 * @param {string} response - LLM response text
 * @returns {Array<{number: number, label: string, summary: string}>}
 */
export function parseTopicList(response) {
  const topics = [];
  const lines = response.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s*(.+?)(?:\s*[—–-]\s*(.+))?$/);
    if (match) {
      topics.push({
        number: parseInt(match[1]),
        label: match[2].trim(),
        summary: match[3]?.trim() || '',
      });
    }
  }

  return topics;
}

/**
 * Format the topic list for WhatsApp display.
 * @param {Array} topics
 * @param {string} mode - 'critique' or 'summary'
 * @returns {string}
 */
export function formatTopicSelection(topics, mode) {
  if (topics.length === 0) {
    return "I couldn't identify distinct topics in the recent conversation.";
  }

  const modeLabel = mode === 'critique' ? 'critique' : 'summarise';
  const lines = topics.map(t =>
    `*${t.number}.* ${t.label}${t.summary ? ` — ${t.summary}` : ''}`
  );

  return `I can see *${topics.length} topic${topics.length > 1 ? 's' : ''}* in the recent conversation:\n\n${lines.join('\n')}\n\nWhich ${topics.length > 1 ? 'ones' : 'one'} should I ${modeLabel}? Reply with numbers (e.g. "1 and 3" or "all").`;
}
