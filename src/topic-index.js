// src/topic-index.js — Overnight topic indexing + live topic retrieval
// Builds a structured topic index from group conversation logs.
// Overnight: EVO 30B clusters yesterday's messages into topics, stores in JSONL.
// On-demand: merges historical index with today's unindexed messages.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';
import { getRecentGroupMessages, formatTranscript, buildSegmentationPrompt, parseTopicList } from './topic-scan.js';

// Lazy import to avoid pulling config.js (and its ANTHROPIC_API_KEY check) at module load
let _evoSimpleChat = null;
async function getEvoSimpleChat() {
  if (!_evoSimpleChat) {
    const mod = await import('./evo-llm.js');
    _evoSimpleChat = mod.evoSimpleChat;
  }
  return _evoSimpleChat;
}

const DATA_DIR = join('data');
const TOPIC_INDEX_DIR = join(DATA_DIR, 'topic-index');
const CONV_LOG_DIR = join(DATA_DIR, 'conversation-logs');

// Ensure directory exists
if (!existsSync(TOPIC_INDEX_DIR)) mkdirSync(TOPIC_INDEX_DIR, { recursive: true });

/**
 * @typedef {Object} IndexedTopic
 * @property {string} groupJid - Group JID
 * @property {string} date - YYYY-MM-DD
 * @property {number} number - Topic number within that day
 * @property {string} label - Short topic label
 * @property {string} summary - 1-2 sentence summary
 * @property {string[]} participants - Unique senders who contributed
 * @property {number} messageCount - Number of messages in this topic
 * @property {string} transcript - The actual messages for this topic (for execution)
 */

// ── OVERNIGHT INDEXING ──────────────────────────────────────────────────────

/**
 * Index topics from a specific day's group conversation logs.
 * Called overnight by the scheduler. Uses EVO 30B for clustering (free).
 *
 * @param {string} dateStr - YYYY-MM-DD to index
 * @returns {number} - Total topics indexed across all groups
 */
export async function indexDayTopics(dateStr) {
  if (!existsSync(CONV_LOG_DIR)) return 0;

  const files = readdirSync(CONV_LOG_DIR)
    .filter(f => f.startsWith(dateStr) && f.endsWith('.jsonl') && f.includes('g_us'));

  if (files.length === 0) return 0;

  let totalTopics = 0;

  for (const file of files) {
    const jidMatch = file.match(/\d{4}-\d{2}-\d{2}_(.+)\.jsonl$/);
    if (!jidMatch) continue;

    // Reconstruct JID from sanitised filename
    const sanitisedJid = jidMatch[1];
    const groupJid = sanitisedJid.replace(/_/g, '.').replace(/\.g\.us$/, '@g.us');

    try {
      const topics = await indexGroupDay(groupJid, dateStr, file);
      totalTopics += topics;
    } catch (err) {
      logger.error({ err: err.message, file, dateStr }, 'topic-index: failed to index group');
    }
  }

  logger.info({ dateStr, totalTopics }, 'topic-index: overnight indexing complete');
  return totalTopics;
}

/**
 * Index topics for a single group on a single day.
 */
async function indexGroupDay(groupJid, dateStr, filename) {
  const filepath = join(CONV_LOG_DIR, filename);
  if (!existsSync(filepath)) return 0;

  const lines = readFileSync(filepath, 'utf-8').split('\n').filter(l => l.trim());
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip */ }
  }

  // Need at least 3 human messages to bother indexing
  const humanMsgs = messages.filter(m => !m.isBot);
  if (humanMsgs.length < 3) return 0;

  const transcript = formatTranscript(messages);

  // Use EVO 30B for topic clustering (free)
  const segPrompt = buildSegmentationPrompt(transcript);
  const evoChat = await getEvoSimpleChat();
  const segResponse = await evoChat(
    'You are a conversation analyst. Follow the instructions precisely.',
    segPrompt, 1000
  );

  if (!segResponse) {
    logger.warn({ groupJid, dateStr }, 'topic-index: EVO segmentation returned null');
    return 0;
  }

  const topics = parseTopicList(segResponse);
  if (topics.length === 0) return 0;

  // Extract participants per topic (approximate: assign by message proximity)
  // Since we can't perfectly assign messages to topics without another LLM call,
  // we store all participants and the full transcript per day-group.
  const participants = [...new Set(humanMsgs.map(m => m.sender).filter(Boolean))];

  // Write to topic index
  const indexFile = join(TOPIC_INDEX_DIR, `${groupJid.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`);

  for (const topic of topics) {
    const entry = {
      groupJid,
      date: dateStr,
      number: topic.number,
      label: topic.label,
      summary: topic.summary,
      participants,
      messageCount: messages.length,
      indexedAt: new Date().toISOString(),
    };
    appendFileSync(indexFile, JSON.stringify(entry) + '\n');
  }

  logger.info({ groupJid, dateStr, topicCount: topics.length }, 'topic-index: group indexed');
  return topics.length;
}

// ── RETRIEVAL ───────────────────────────────────────────────────────────────

/**
 * Get recent topics for a group — merges historical index with today's live messages.
 * Returns structured topics ready for presentation. Today's messages are clustered
 * on-demand via EVO (or returned as a single "today's discussion" block if EVO is down).
 *
 * @param {string} chatJid - Group JID
 * @param {number} historyDays - How many days of history to include (default 3)
 * @returns {Promise<{historical: IndexedTopic[], today: IndexedTopic[], transcript: string}>}
 */
export async function getGroupTopics(chatJid, historyDays = 3) {
  // 1. Read historical topics from index
  const historical = readHistoricalTopics(chatJid, historyDays);

  // 2. Get today's messages and cluster them live
  const todayMessages = getRecentGroupMessages(chatJid, 100);
  const humanToday = todayMessages.filter(m => !m.isBot);

  let today = [];
  let transcript = '';

  if (humanToday.length >= 3) {
    transcript = formatTranscript(todayMessages);
    const segPrompt = buildSegmentationPrompt(transcript);

    const evoChat = await getEvoSimpleChat();
    const segResponse = await evoChat(
      'You are a conversation analyst. Follow the instructions precisely.',
      segPrompt, 1000
    );

    if (segResponse) {
      const parsed = parseTopicList(segResponse);
      const participants = [...new Set(humanToday.map(m => m.sender).filter(Boolean))];
      const todayStr = new Date().toISOString().split('T')[0];

      today = parsed.map(t => ({
        groupJid: chatJid,
        date: todayStr,
        number: t.number,
        label: t.label,
        summary: t.summary,
        participants,
        messageCount: todayMessages.length,
      }));
    }
  } else if (todayMessages.length > 0) {
    transcript = formatTranscript(todayMessages);
  }

  return { historical, today, transcript };
}

/**
 * Read historical topics from the index file for a group.
 */
function readHistoricalTopics(chatJid, days) {
  const indexFile = join(TOPIC_INDEX_DIR, `${chatJid.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`);
  if (!existsSync(indexFile)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const lines = readFileSync(indexFile, 'utf-8').split('\n').filter(l => l.trim());
  const topics = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.date >= cutoffStr) topics.push(entry);
    } catch { /* skip */ }
  }

  // Sort by date desc, then topic number
  topics.sort((a, b) => b.date.localeCompare(a.date) || a.number - b.number);
  return topics;
}

/**
 * Format topics for WhatsApp display — merges historical and today's topics.
 * Groups by date, numbers continuously.
 *
 * @param {IndexedTopic[]} historical
 * @param {IndexedTopic[]} today
 * @param {string} mode - 'critique' or 'summary'
 * @returns {string}
 */
export function formatTopicsForSelection(historical, today, mode) {
  const allTopics = [];
  let num = 1;

  // Today first (most relevant)
  if (today.length > 0) {
    allTopics.push({ header: '*Today*', topics: [] });
    for (const t of today) {
      allTopics[allTopics.length - 1].topics.push({ ...t, displayNum: num++ });
    }
  }

  // Historical by date
  const byDate = {};
  for (const t of historical) {
    if (!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  }

  for (const date of Object.keys(byDate).sort().reverse()) {
    const d = new Date(date + 'T12:00:00');
    const label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    allTopics.push({ header: `*${label}*`, topics: [] });
    for (const t of byDate[date]) {
      allTopics[allTopics.length - 1].topics.push({ ...t, displayNum: num++ });
    }
  }

  if (num === 1) {
    return "Not enough conversation history to identify topics.";
  }

  const modeLabel = mode === 'critique' ? 'critique' : 'summarise';
  const lines = [];
  for (const group of allTopics) {
    lines.push(group.header);
    for (const t of group.topics) {
      lines.push(`*${t.displayNum}.* ${t.label}${t.summary ? ` — ${t.summary}` : ''}`);
    }
    lines.push('');
  }

  const total = num - 1;
  return `I can see *${total} topic${total > 1 ? 's' : ''}* in recent conversation:\n\n${lines.join('\n').trim()}\n\nWhich ${total > 1 ? 'ones' : 'one'} should I ${modeLabel}? Reply with numbers (e.g. "1 and 3" or "all").`;
}

/**
 * Get the transcript for specific topic numbers from the combined list.
 * For today's topics: uses the live transcript.
 * For historical topics: reads from conversation logs.
 *
 * @param {IndexedTopic[]} historical
 * @param {IndexedTopic[]} today
 * @param {string} todayTranscript
 * @param {number[]|'all'} selection
 * @returns {string} - Combined transcript for selected topics
 */
export function getTranscriptForSelection(historical, today, todayTranscript, selection) {
  // Build the same numbering as formatTopicsForSelection
  const allTopics = [];
  let num = 1;

  for (const t of today) {
    allTopics.push({ ...t, displayNum: num++, source: 'today' });
  }
  for (const t of historical) {
    allTopics.push({ ...t, displayNum: num++, source: 'historical' });
  }

  const selected = selection === 'all'
    ? allTopics
    : allTopics.filter(t => selection.includes(t.displayNum));

  if (selected.length === 0) return todayTranscript || '';

  // For today's topics, use the live transcript
  const needsToday = selected.some(t => t.source === 'today');
  const needsHistorical = selected.filter(t => t.source === 'historical');

  const parts = [];

  if (needsToday && todayTranscript) {
    parts.push('## Today\'s conversation\n' + todayTranscript);
  }

  // For historical topics, read from logs
  const dateGroups = {};
  for (const t of needsHistorical) {
    if (!dateGroups[t.date]) dateGroups[t.date] = t;
  }

  for (const date of Object.keys(dateGroups)) {
    const transcript = readDayTranscript(selected[0]?.groupJid || '', date);
    if (transcript) {
      const d = new Date(date + 'T12:00:00');
      const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      parts.push(`## ${label}\n${transcript}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Read a day's transcript for a group from conversation logs.
 */
function readDayTranscript(groupJid, dateStr) {
  const sanitised = groupJid.replace(/[^a-zA-Z0-9]/g, '_');
  const filepath = join(CONV_LOG_DIR, `${dateStr}_${sanitised}.jsonl`);
  if (!existsSync(filepath)) return null;

  const lines = readFileSync(filepath, 'utf-8').split('\n').filter(l => l.trim());
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch { /* skip */ }
  }

  return formatTranscript(messages);
}

/**
 * Prune topic index entries older than maxDays.
 * Called during overnight housekeeping.
 *
 * @param {number} maxDays - Maximum age in days (default 30)
 */
export function pruneTopicIndex(maxDays = 30) {
  if (!existsSync(TOPIC_INDEX_DIR)) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const files = readdirSync(TOPIC_INDEX_DIR).filter(f => f.endsWith('.jsonl'));

  for (const file of files) {
    const filepath = join(TOPIC_INDEX_DIR, file);
    const lines = readFileSync(filepath, 'utf-8').split('\n').filter(l => l.trim());
    const kept = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.date >= cutoffStr) kept.push(line);
      } catch {
        // skip malformed
      }
    }

    if (kept.length < lines.length) {
      writeFileSync(filepath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
      logger.info({ file, before: lines.length, after: kept.length }, 'topic-index: pruned old entries');
    }
  }
}
