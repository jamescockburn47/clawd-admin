/**
 * Memory client — connects Pi to EVO X2 memory service.
 * Handles health monitoring, search, store, queue, cache, and fallback.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { evoFetchJSON, evoFetch as evoFetchRaw } from './evo-client.js';
import { TIMEOUTS } from './constants.js';

// Re-export logConversation for backward compatibility
export { logConversation } from './conversation-logger.js';

const CACHE_FILE = join('data', 'memory-cache.json');
const QUEUE_DIR = join('data', 'memory-queue');
const QUEUE_TEXT_DIR = join(QUEUE_DIR, 'text');
const QUEUE_AUDIO_DIR = join(QUEUE_DIR, 'audio');
const QUEUE_IMAGE_DIR = join(QUEUE_DIR, 'images');

// State
let evoOnline = false;
let consecutiveFailures = 0;
let memoryCache = [];
let cacheTimestamp = 0;

// Ensure directories exist
for (const dir of [QUEUE_TEXT_DIR, QUEUE_AUDIO_DIR, QUEUE_IMAGE_DIR]) {
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


// Convenience wrapper: fetch from the memory service base URL, return parsed JSON
async function memoryFetch(path, options = {}) {
  const url = `${config.evoMemoryUrl}${path}`;
  return evoFetchJSON(url, options);
}


// --- Health monitoring ---

let lastHealthData = null;

export async function checkEvoHealth() {
  try {
    const data = await memoryFetch('/health', { timeout: TIMEOUTS.MEMORY_HEALTH_CHECK });
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
      const data = await memoryFetch('/memory/search', {
        method: 'POST',
        body: JSON.stringify({ query, category, limit }),
        timeout: TIMEOUTS.MEMORY_SEARCH,
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
      const data = await memoryFetch('/memory/store', {
        method: 'POST',
        body: JSON.stringify({ fact, category, tags, confidence, source }),
        timeout: TIMEOUTS.MEMORY_STORE,
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
      const data = await memoryFetch('/note', {
        method: 'POST',
        body: JSON.stringify({ text, source }),
        timeout: TIMEOUTS.MEMORY_NOTE,
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
      const data = await memoryFetch('/extract', {
        method: 'POST',
        body: JSON.stringify({ conversation, store_results: true, source }),
        timeout: TIMEOUTS.MEMORY_EXTRACT,
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
      const resp = await evoFetchRaw(url, {
        method: 'POST',
        body: formData,
        headers: {},  // Let browser set multipart boundary
        timeout: TIMEOUTS.MEMORY_IMAGE,
      });
      return await resp.json();
    } catch (err) {
      logger.warn({ err: err.message }, 'EVO X2 image analysis failed');
    }
  }

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
      const resp = await evoFetchRaw(url, {
        method: 'POST',
        body: formData,
        headers: {},  // Let browser set multipart boundary
        timeout: TIMEOUTS.MEMORY_AUDIO,
      });
      return await resp.json();
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
    const data = await memoryFetch(`/memory/${memoryId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
      timeout: TIMEOUTS.MEMORY_STORE,
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
    const data = await memoryFetch(`/memory/${memoryId}`, {
      method: 'DELETE',
      timeout: TIMEOUTS.MEMORY_DEFAULT,
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
      return await memoryFetch('/memory/stats', { timeout: TIMEOUTS.MEMORY_HEALTH_CHECK });
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
      const data = await memoryFetch('/memory/list', { timeout: TIMEOUTS.MEMORY_DEFAULT });
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

  const tokens = messageText.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  if (tokens.length === 0) return [];

  const results = await searchMemory(messageText, null, 8);

  // If message references a document, also search document chunks specifically
  const docPattern = /\b(document|doc|file|pdf|report|analysis|the\s+\w+\.(?:md|pdf|docx|csv))\b/i;
  if (docPattern.test(messageText)) {
    try {
      const docResults = await searchMemory(messageText, 'document_chunk', 4);
      const docSummaries = await searchMemory(messageText, 'document', 2);
      const existingIds = new Set(results.map(r => (r.memory || r).id));
      for (const r of [...docResults, ...docSummaries]) {
        const id = (r.memory || r).id;
        if (id && !existingIds.has(id)) {
          results.push(r);
          existingIds.add(id);
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'document memory search failed');
    }
  }

  return results
    .filter((r) => (r.score ?? 0) >= 0.12)
    .map((r) => r.memory);
}

export async function getDreamMemories(groupJid, limit = 3) {
  if (!evoOnline) return [];
  try {
    const results = await searchMemory(`dream summary ${groupJid}`, 'dream', limit);
    return results.map(r => r.memory || r).filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'dream memory fetch failed');
    return [];
  }
}

export async function getIdentityMemories() {
  if (!evoOnline) return [];
  try {
    const results = await searchMemory('identity core permanent', 'identity', 10);
    return results.map(r => r.memory || r).filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'identity memory fetch failed');
    return [];
  }
}

export async function getOvernightInsights(dateStr) {
  if (!evoOnline) return [];
  try {
    const results = await searchMemory(`diary_insight ${dateStr}`, 'insight', 8);
    const byDate = (results || [])
      .map(r => r.memory || r)
      .filter(m => m && (m.tags || []).includes(dateStr));
    return byDate;
  } catch (err) {
    logger.warn({ err: err.message }, 'overnight insight fetch failed');
    return [];
  }
}

export async function getInsightMemories(query, limit = 3) {
  if (!evoOnline) return [];
  try {
    const results = await searchMemory(query, 'insight', limit);
    return (results || [])
      .filter(r => (r.score ?? 0) >= 0.20)
      .map(r => r.memory || r)
      .filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'insight memory fetch failed');
    return [];
  }
}

export function formatMemoriesForPrompt(memories) {
  if (!memories || memories.length === 0) return '';

  const lines = memories.map(m => {
    const date = m.sourceDate || '?';
    return `- ${m.fact} [${m.category}, ${date}]`;
  });

  return `\n\n## What you remember\n${lines.join('\n')}`;
}


// --- Document storage ---

const DOC_LOG_DIR = join(process.cwd(), 'data', 'document-logs');
const DOC_CACHE_DIR = join(process.cwd(), 'data', 'document-cache');

for (const dir of [DOC_LOG_DIR, DOC_CACHE_DIR]) {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
}

export async function storeDocument({ fileName, rawText, summary, sender, chatJid }) {
  const date = new Date().toISOString().split('T')[0];
  const baseTags = [fileName.replace(/\s+/g, '_'), date, sender || 'unknown'];

  try {
    await storeMemory(
      `Document "${fileName}" (${rawText.length} chars, from ${sender || 'unknown'}): ${summary}`,
      'document', [...baseTags, 'summary'], 0.9, 'document_intake',
    );
  } catch (err) {
    logger.warn({ err: err.message, fileName }, 'failed to store document summary');
  }

  const chunks = chunkText(rawText, 2000);
  let storedChunks = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      await storeMemory(
        `[${fileName} chunk ${i + 1}/${chunks.length}] ${chunks[i]}`,
        'document_chunk', [...baseTags, `chunk_${i}`], 0.85, 'document_intake',
      );
      storedChunks++;
    } catch (err) {
      logger.warn({ err: err.message, fileName, chunk: i }, 'failed to store document chunk');
    }
  }

  try {
    await storeMemory(
      `Document index: "${fileName}", ${rawText.length} chars, ${chunks.length} chunks, from ${sender || 'unknown'} on ${date}. Summary: ${summary.slice(0, 200)}`,
      'document_index', [...baseTags, 'index'], 1.0, 'document_intake',
    );
  } catch (err) {
    logger.warn({ err: err.message, fileName }, 'failed to store document index');
  }

  try {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const rawPath = join(DOC_CACHE_DIR, `${date}_${safeName}`);
    writeFileSync(rawPath, rawText);

    const logFile = join(DOC_LOG_DIR, `${date}.jsonl`);
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      fileName, sender: sender || 'unknown', chatJid: chatJid || 'unknown',
      charCount: rawText.length, summary: summary.slice(0, 1000), rawTextPath: rawPath,
    });
    appendFileSync(logFile, logEntry + '\n');
  } catch (err) {
    logger.warn({ err: err.message, fileName }, 'failed to write document log');
  }

  logger.info({ fileName, chunks: storedChunks, totalChunks: chunks.length }, 'document stored in memory');
  return { storedChunks, totalChunks: chunks.length };
}

function chunkText(text, maxChars = 2000) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxChars) {
        result.push(chunk.slice(i, i + maxChars));
      }
    }
  }
  return result;
}

export function cleanDocumentCache(maxAgeDays = 7) {
  try {
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(DOC_CACHE_DIR);
    let cleaned = 0;
    for (const f of files) {
      const filepath = join(DOC_CACHE_DIR, f);
      const stat = statSync(filepath);
      if (now - stat.mtimeMs > maxAge) {
        unlinkSync(filepath);
        cleaned++;
      }
    }
    if (cleaned > 0) logger.info({ cleaned }, 'document cache cleaned');
  } catch (err) {
    logger.warn({ err: err.message }, 'document cache cleanup failed');
  }
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
        await memoryFetch('/memory/store', {
          method: 'POST', body: JSON.stringify(data), timeout: TIMEOUTS.MEMORY_STORE,
        });
      } else if (data.type === 'note') {
        await memoryFetch('/note', {
          method: 'POST', body: JSON.stringify({ text: data.text, source: data.source }), timeout: TIMEOUTS.MEMORY_NOTE,
        });
      } else if (data.type === 'extract') {
        await memoryFetch('/extract', {
          method: 'POST',
          body: JSON.stringify({ conversation: data.conversation, store_results: true, source: data.source }),
          timeout: TIMEOUTS.MEMORY_EXTRACT,
        });
      }

      unlinkSync(filepath);
      processed++;
    } catch (err) {
      logger.error({ err: err.message, file }, 'failed to process queued item');
      break;
    }
  }

  if (processed > 0) {
    logger.info({ processed }, 'queue drain complete');
  }
}


// --- Cache sync ---

export async function syncCache() {
  try {
    const data = await memoryFetch('/memory/list', { timeout: TIMEOUTS.MEMORY_SEARCH });
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


// --- Trigger maintenance ---

export async function triggerMaintenance() {
  if (!evoOnline) return { error: 'EVO X2 offline' };
  try {
    return await memoryFetch('/maintain', { method: 'POST', timeout: TIMEOUTS.MEMORY_STORE });
  } catch (err) {
    return { error: err.message };
  }
}
