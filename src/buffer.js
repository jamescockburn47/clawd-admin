// Message buffer — rolling conversation context per chat with optional persistence
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
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
    const name = msg.isBot ? 'Clawd (you)' : msg.senderName;
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
