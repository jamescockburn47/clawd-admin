// Message buffer — rolling conversation context per chat with optional persistence
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const MESSAGES_FILE = join(DATA_DIR, 'messages.json');

const buffers = new Map();
let saveTimer = null;

export function pushMessage(chatJid, entry) {
  if (!buffers.has(chatJid)) {
    buffers.set(chatJid, []);
  }
  const buf = buffers.get(chatJid);
  buf.push({
    senderName: entry.senderName || 'Unknown',
    text: entry.text || '',
    hasImage: entry.hasImage || false,
    isBot: entry.isBot || false,
    timestamp: entry.timestamp || Date.now(),
  });
  if (buf.length > config.contextMessageCount) {
    buf.shift();
  }
  scheduleSave();
}

export function buildContext(chatJid, triggerText) {
  const buf = buffers.get(chatJid) || [];
  if (buf.length === 0) return triggerText;

  const lines = buf.map((msg) => {
    const name = msg.isBot ? 'Clint (you)' : msg.senderName;
    const content = msg.hasImage && !msg.text ? '[sent a photo]'
      : msg.hasImage ? `${msg.text} [sent a photo]`
      : msg.text;
    return `${name}: ${content}`;
  });

  return `[Recent conversation]\n${lines.join('\n')}\n\n[Current message]\n${triggerText}`;
}

export function botRecentlySpokeIn(chatJid) {
  const buf = buffers.get(chatJid) || [];
  const recent = buf.slice(-4);
  return recent.some((msg) => msg.isBot);
}

export function getRecentMessages(chatJid) {
  return buffers.get(chatJid) || [];
}

/**
 * Return a merged, time-sorted feed of recent messages from ALL chat buffers.
 * Each message is annotated with its chatJid for display.
 * @param {number} limit — max messages to return (default 100)
 */
export function getAllRecentMessages(limit = 100) {
  const all = [];
  for (const [chatJid, msgs] of buffers.entries()) {
    for (const msg of msgs) {
      all.push({ ...msg, chatJid });
    }
  }
  // Sort by timestamp descending (newest first)
  all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return all.slice(0, limit);
}

// --- Group buffer rehydration from conversation logs ---

const CONV_LOG_DIR = join(DATA_DIR, 'conversation-logs');

/**
 * Rehydrate group buffers from today's conversation logs on startup.
 * Without this, every restart wipes group context and Clint loses
 * track of the current conversation.
 */
export function rehydrateGroupBuffers() {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (!existsSync(CONV_LOG_DIR)) return;

    const files = readdirSync(CONV_LOG_DIR).filter(f =>
      f.startsWith(today) && f.endsWith('.jsonl') && f.includes('_g_us')
    );

    let totalRestored = 0;
    for (const file of files) {
      // Extract JID from filename: 2026-04-09_120363407496928531_g_us.jsonl
      const jidPart = file.replace(`${today}_`, '').replace('.jsonl', '').replace(/_/g, '.');
      // Reconstruct proper JID format
      const chatJid = jidPart.replace(/\.g\.us$/, '@g.us');

      const content = readFileSync(join(CONV_LOG_DIR, file), 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      // Load more than the runtime buffer size — gives proper conversation context
      // after restarts. Runtime pushMessage() will naturally trim to contextMessageCount.
      const REHYDRATION_DEPTH = 50;
      const recent = lines.slice(-REHYDRATION_DEPTH);

      // Build buffer directly — bypass pushMessage's trim so we can load full depth
      const entries = [];
      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          entries.push({
            senderName: entry.sender || 'Unknown',
            text: entry.text || '',
            hasImage: false,
            isBot: entry.isBot || false,
            timestamp: new Date(entry.timestamp).getTime(),
          });
        } catch {
          // intentional: skip malformed log lines
        }
      }
      if (entries.length > 0) {
        buffers.set(chatJid, entries);
        totalRestored += entries.length;
        logger.info({ chatJid: chatJid.slice(0, 25), count: entries.length }, 'rehydrated group buffer from logs');
      }
    }

    if (totalRestored > 0) {
      logger.info({ totalRestored, files: files.length }, 'group buffers rehydrated from conversation logs');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'group buffer rehydration failed');
  }
}

// --- Persistence (owner's DM buffer only) ---

function getOwnerJid() {
  return config.ownerJid || null;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBuffers().catch(() => {});
  }, 5 * 60 * 1000); // debounce: save every 5 minutes
}

export async function saveBuffers() {
  const ownerJid = getOwnerJid();
  if (!ownerJid) return;

  const ownerBuf = buffers.get(ownerJid);
  if (!ownerBuf || ownerBuf.length === 0) return;

  try {
    await mkdir(DATA_DIR, { recursive: true });
    const data = { [ownerJid]: ownerBuf };
    await writeFile(MESSAGES_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error({ err: err.message }, 'buffer save failed');
  }
}

export async function loadBuffers() {
  if (!existsSync(MESSAGES_FILE)) return;
  try {
    const data = JSON.parse(await readFile(MESSAGES_FILE, 'utf-8'));
    for (const [jid, messages] of Object.entries(data)) {
      if (Array.isArray(messages) && messages.length > 0) {
        // Only keep up to contextMessageCount
        const trimmed = messages.slice(-config.contextMessageCount);
        buffers.set(jid, trimmed);
        logger.info({ jid, count: trimmed.length }, 'restored message buffer');
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'could not load message buffer');
  }
}

export function flushBufferTimer() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
