/**
 * Memory client — connects Pi to EVO X2 memory service.
 * Handles health monitoring, search, store, queue, cache, and fallback.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';

const CACHE_FILE = join('data', 'memory-cache.json');
const QUEUE_DIR = join('data', 'memory-queue');
const QUEUE_TEXT_DIR = join(QUEUE_DIR, 'text');
const QUEUE_AUDIO_DIR = join(QUEUE_DIR, 'audio');
const QUEUE_IMAGE_DIR = join(QUEUE_DIR, 'images');
const CONV_LOG_DIR = join('data', 'conversation-logs');

// State
let evoOnline = false;
let consecutiveFailures = 0;
let memoryCache = [];
let cacheTimestamp = 0;

// Ensure directories exist
for (const dir of [QUEUE_TEXT_DIR, QUEUE_AUDIO_DIR, QUEUE_IMAGE_DIR, CONV_LOG_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// Load cache on startup
try {
  if (existsSync(CACHE_FILE)) {
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    memoryCache = data.memories || [];
    cacheTimestamp = data.timestamp || 0;
    logger.info({ count: memoryCache.length }, 'memory cache loaded');
  }
} catch (err) {
  logger.warn({ err: err.message }, 'failed to load memory cache');
}


async function evoFetch(path, options = {}) {
  const url = `${config.evoMemoryUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 10000);

  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}


// --- Health monitoring ---

let lastHealthData = null;

export async function checkEvoHealth() {
  try {
    const data = await evoFetch('/health', { timeout: 5000 });
    if (data.status === 'online') {
      const wasOffline = !evoOnline;
      evoOnline = true;
      consecutiveFailures = 0;
      lastHealthData = data;

      if (wasOffline) {
        logger.info('EVO X2 came online — draining queue and syncing cache');
        drainQueue().catch(err => logger.error({ err: err.message }, 'queue drain failed'));
        syncCache().catch(err => logger.error({ err: err.message }, 'cache sync failed'));
      }
      return data;
    }
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= 3 && evoOnline) {
      evoOnline = false;
      logger.warn('EVO X2 marked offline after 3 consecutive failures');
    }
  }
  return null;
}

export function getLastHealthData() {
  return lastHealthData;
}

export function isEvoOnline() {
  return evoOnline;
}

export function getEvoStatus() {
  return {
    online: evoOnline,
    consecutiveFailures,
    cacheSize: memoryCache.length,
    cacheAge: cacheTimestamp ? Math.round((Date.now() - cacheTimestamp) / 1000) : null,
    queueDepth: getQueueDepth(),
  };
}


// --- Memory search ---

export async function searchMemory(query, category = null, limit = 8) {
  if (evoOnline) {
    try {
      const data = await evoFetch('/memory/search', {
        method: 'POST',
        body: JSON.stringify({ query, category, limit }),
        timeout: 15000,
      });
      return data.results || [];
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 search failed, falling back to cache');
    }
  }

  // Fallback: keyword search against local cache
  return keywordSearch(query, category, limit);
}

function keywordSearch(query, category, limit) {
  const tokens = new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 2));
  if (tokens.size === 0) return [];

  const scored = [];
  for (const m of memoryCache) {
    if (category && m.category !== category) continue;

    const tags = new Set(m.tags || []);
    const factTokens = new Set(m.fact.toLowerCase().split(/\W+/).filter(t => t.length > 2));
    const allTokens = new Set([...tags, ...factTokens]);

    let matches = 0;
    for (const t of tokens) {
      if (allTokens.has(t)) matches++;
    }

    if (matches > 0) {
      scored.push({ score: matches / tokens.size, memory: m });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}


// --- Memory store ---

export async function storeMemory(fact, category, tags, confidence = 0.9, source = 'api') {
  if (evoOnline) {
    try {
      const data = await evoFetch('/memory/store', {
        method: 'POST',
        body: JSON.stringify({ fact, category, tags, confidence, source }),
        timeout: 30000,
      });
      return data;
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 store failed, queuing locally');
    }
  }

  // Queue for later
  queueItem('text', { type: 'store', fact, category, tags, confidence, source });
  return { stored: false, queued: true };
}


// --- Store a note (direct) ---

export async function storeNote(text, source = 'manual_note') {
  if (evoOnline) {
    try {
      const data = await evoFetch('/note', {
        method: 'POST',
        body: JSON.stringify({ text, source }),
        timeout: 60000,
      });
      return data;
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 note store failed, queuing');
    }
  }

  queueItem('text', { type: 'note', text, source });
  return { stored: false, queued: true };
}


// --- Extract facts from conversation ---

export async function extractFromConversation(conversation, source = 'conversation') {
  if (evoOnline) {
    try {
      const data = await evoFetch('/extract', {
        method: 'POST',
        body: JSON.stringify({ conversation, store_results: true, source }),
        timeout: 120000,
      });
      return data;
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 extraction failed, queuing');
    }
  }

  queueItem('text', { type: 'extract', conversation, source });
  return { extracted: [], queued: true };
}


// --- Image analysis ---

export async function analyseImage(imageBuffer, prompt, extract = true, storeResults = true) {
  if (evoOnline) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([imageBuffer]), 'image.jpg');
      formData.append('prompt', prompt || 'Describe this image in detail. Extract any text, numbers, names, dates visible.');
      formData.append('extract', String(extract));
      formData.append('store_results', String(storeResults));

      const url = `${config.evoMemoryUrl}/analyse-image`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      try {
        const resp = await fetch(url, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (err) {
        clearTimeout(timeout);
        throw err;
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 image analysis failed');
    }
  }

  // No fallback queuing for images — return null to trigger Claude vision fallback
  return null;
}


// --- Transcription ---

export async function transcribeAudio(audioBuffer, language = 'en', extract = true, storeResults = true) {
  if (evoOnline) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'audio.ogg');
      formData.append('language', language);
      formData.append('extract', String(extract));
      formData.append('store_results', String(storeResults));

      const url = `${config.evoMemoryUrl}/transcribe`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);

      try {
        const resp = await fetch(url, {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (err) {
        clearTimeout(timeout);
        throw err;
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 transcription failed');
    }
  }

  return null;
}


// --- Memory update/delete ---

export async function updateMemory(memoryId, updates) {
  if (!evoOnline) return { updated: false, offline: true };

  try {
    const data = await evoFetch(`/memory/${memoryId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
      timeout: 30000,
    });
    return data;
  } catch (err) {
    logger.error({ err: err.message }, 'memory update failed');
    return { updated: false, error: err.message };
  }
}

export async function deleteMemory(memoryId) {
  if (!evoOnline) return { deleted: false, offline: true };

  try {
    const data = await evoFetch(`/memory/${memoryId}`, {
      method: 'DELETE',
      timeout: 10000,
    });
    return data;
  } catch (err) {
    logger.error({ err: err.message }, 'memory delete failed');
    return { deleted: false, error: err.message };
  }
}


// --- Memory stats ---

export async function getMemoryStats() {
  if (evoOnline) {
    try {
      return await evoFetch('/memory/stats', { timeout: 5000 });
    } catch (err) {
      logger.warn({ err: err.message }, 'failed to get memory stats');
    }
  }
  // Fallback from cache
  const cats = {};
  for (const m of memoryCache) {
    cats[m.category] = (cats[m.category] || 0) + 1;
  }
  return { total: memoryCache.length, categories: cats, fromCache: true };
}


// --- List all memories (for dashboard) ---

export async function listMemories() {
  if (evoOnline) {
    try {
      const data = await evoFetch('/memory/list', { timeout: 10000 });
      return data.memories || [];
    } catch (err) {
      logger.warn({ err: err.message }, 'failed to list memories');
    }
  }
  return memoryCache;
}


// --- Passive memory injection ---

export async function getRelevantMemories(messageText) {
  if (!messageText || messageText.length < 5) return [];

  // Quick keyword check — skip embedding for trivial messages
  const tokens = messageText.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (tokens.length === 0) return [];

  const results = await searchMemory(messageText, null, 8);

  // Filter to only reasonably relevant results
  return results
    .filter(r => r.score > 0.2)
    .map(r => r.memory);
}

export function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';

  const lines = memories.map(m => {
    const date = m.sourceDate || '?';
    return `- ${m.fact} [${m.category}, ${date}]`;
  });

  return `\n\n## What you remember\n${lines.join('\n')}`;
}


// --- Queue system ---

function queueItem(type, data) {
  const dir = type === 'audio' ? QUEUE_AUDIO_DIR : type === 'images' ? QUEUE_IMAGE_DIR : QUEUE_TEXT_DIR;
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(data));
  logger.info({ type, filename }, 'item queued for EVO X2');
}

function getQueueDepth() {
  let count = 0;
  for (const dir of [QUEUE_TEXT_DIR, QUEUE_AUDIO_DIR, QUEUE_IMAGE_DIR]) {
    try {
      count += readdirSync(dir).filter(f => f.endsWith('.json')).length;
    } catch {}
  }
  return count;
}

async function drainQueue() {
  const textFiles = readdirSync(QUEUE_TEXT_DIR).filter(f => f.endsWith('.json')).sort();
  let processed = 0;

  for (const file of textFiles) {
    const filepath = join(QUEUE_TEXT_DIR, file);
    try {
      const data = JSON.parse(readFileSync(filepath, 'utf-8'));

      if (data.type === 'store') {
        await evoFetch('/memory/store', {
          method: 'POST',
          body: JSON.stringify(data),
          timeout: 30000,
        });
      } else if (data.type === 'note') {
        await evoFetch('/note', {
          method: 'POST',
          body: JSON.stringify({ text: data.text, source: data.source }),
          timeout: 60000,
        });
      } else if (data.type === 'extract') {
        await evoFetch('/extract', {
          method: 'POST',
          body: JSON.stringify({
            conversation: data.conversation,
            store_results: true,
            source: data.source,
          }),
          timeout: 120000,
        });
      }

      unlinkSync(filepath);
      processed++;
    } catch (err) {
      logger.error({ err: err.message, file }, 'failed to process queued item');
      break; // Stop on error to avoid skipping items
    }
  }

  if (processed > 0) {
    logger.info({ processed }, 'queue drain complete');
  }
}


// --- Cache sync ---

export async function syncCache() {
  try {
    const data = await evoFetch('/memory/list', { timeout: 15000 });
    memoryCache = data.memories || [];
    cacheTimestamp = Date.now();
    writeFileSync(CACHE_FILE, JSON.stringify({
      memories: memoryCache,
      timestamp: cacheTimestamp,
    }));
    logger.info({ count: memoryCache.length }, 'memory cache synced');
  } catch (err) {
    logger.error({ err: err.message }, 'cache sync failed');
  }
}


// --- Conversation logging ---

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


// --- Trigger maintenance ---

export async function triggerMaintenance() {
  if (!evoOnline) return { error: 'EVO X2 offline' };
  try {
    return await evoFetch('/maintain', { method: 'POST', timeout: 30000 });
  } catch (err) {
    return { error: err.message };
  }
}
