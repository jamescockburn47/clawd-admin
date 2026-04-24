// src/lqcouncil/knowledge.js — LQcouncil curated knowledge loader.
//
// Loads data/lqcouncil-knowledge.json (hand-curated chunks distilled from the
// bot-council repo) and exposes retrieval helpers. NOT a full-text RAG —
// deliberate keyword matching over a small corpus (~13 chunks) so retrieval
// is deterministic, debuggable, and the "intelligent" part stays in the
// curation, not in similarity tricks.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_KNOWLEDGE_FILE = join(REPO_ROOT, 'data', 'lqcouncil-knowledge.json');

const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_MAX_CHUNKS = 3;
const TOKENS_PER_CHAR_ESTIMATE = 0.25; // rough: 4 chars ≈ 1 token

let _cache = null;
let _loadedFrom = null;

function load(opts = {}) {
  const file = opts.file ?? DEFAULT_KNOWLEDGE_FILE;
  if (_cache && _loadedFrom === file) return _cache;
  if (!existsSync(file)) {
    logger.warn({ file }, 'lqcouncil-knowledge.json missing — retrieval will return empty results');
    _cache = { version: '0.0.0', chunks: [] };
    _loadedFrom = file;
    return _cache;
  }
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.chunks)) {
      throw new Error('knowledge.json malformed: `chunks` must be an array');
    }
    _cache = parsed;
    _loadedFrom = file;
    logger.info({ chunks: parsed.chunks.length, version: parsed.version }, 'lqcouncil-knowledge loaded');
    return _cache;
  } catch (err) {
    logger.error({ err: err.message, file }, 'failed to load lqcouncil-knowledge.json');
    _cache = { version: '0.0.0', chunks: [] };
    _loadedFrom = file;
    return _cache;
  }
}

/** Test-only: drop the module cache so a rebuilt file takes effect. */
export function resetKnowledgeCacheForTests() {
  _cache = null;
  _loadedFrom = null;
}

/** Load the raw knowledge document (for tests / admin inspection). */
export function getKnowledgeDocument(opts = {}) {
  return load(opts);
}

/** Return the full chunk list without scoring. */
export function getAllChunks(opts = {}) {
  return load(opts).chunks.slice();
}

/** Look up a chunk by id. Returns null if not found. */
export function getChunkById(id, opts = {}) {
  if (!id || typeof id !== 'string') return null;
  return load(opts).chunks.find((c) => c.id === id) ?? null;
}

function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stemming-lite: drop trailing 's' on words >= 4 chars so `fields` matches `field`. */
function stem(tok) {
  return tok.length >= 4 && tok.endsWith('s') ? tok.slice(0, -1) : tok;
}

function tokenise(text) {
  return normalise(text)
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .map(stem);
}

/**
 * Score chunks by keyword overlap with the query. Two signals:
 *   (a) exact phrase match → big weight (precision).
 *   (b) per-token overlap (after stemming) → smaller weight (recall).
 * Longer keyword matches weigh more so "how to join lqcouncil" picks the
 * onboarding chunk over anything with a single-word keyword hit.
 */
function scoreChunk(queryNorm, chunk) {
  const qTokens = new Set(tokenise(queryNorm));
  let score = 0;
  const matchedKeywords = [];
  for (const keyword of chunk.keywords || []) {
    const kwNorm = normalise(keyword);
    if (!kwNorm) continue;
    // Exact phrase match: precision weight.
    if (queryNorm.includes(kwNorm)) {
      score += kwNorm.length * 3;
      matchedKeywords.push(keyword);
      continue;
    }
    // Per-token overlap (stemmed): recall weight.
    const kwTokens = tokenise(keyword);
    if (kwTokens.length === 0) continue;
    let tokenHits = 0;
    for (const t of kwTokens) if (qTokens.has(t)) tokenHits++;
    if (tokenHits > 0) {
      score += tokenHits * 2;
      matchedKeywords.push(keyword);
    }
  }
  return { score, matchedKeywords };
}

function estimateTokens(chunk) {
  if (typeof chunk.tokens_estimate === 'number' && chunk.tokens_estimate > 0) {
    return chunk.tokens_estimate;
  }
  return Math.ceil((chunk.content?.length ?? 0) * TOKENS_PER_CHAR_ESTIMATE);
}

/**
 * Find the top-N chunks relevant to a query, capped by a token budget.
 * Returns an array of {id, title, content, matchedKeywords, score} with
 * score > 0 only. Empty array if nothing matched.
 */
export function findRelevantChunks(query, opts = {}) {
  const { maxTokens = DEFAULT_MAX_TOKENS, maxChunks = DEFAULT_MAX_CHUNKS, file } = opts;
  const qNorm = normalise(query);
  if (!qNorm) return [];
  const doc = load({ file });
  const scored = doc.chunks.map((chunk) => ({
    chunk,
    ...scoreChunk(qNorm, chunk),
  }));
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  let tokens = 0;
  for (const { chunk, score, matchedKeywords } of scored) {
    if (score <= 0) break;
    if (out.length >= maxChunks) break;
    const cost = estimateTokens(chunk);
    if (tokens + cost > maxTokens && out.length > 0) break;
    out.push({
      id: chunk.id,
      title: chunk.title,
      content: chunk.content,
      matchedKeywords,
      score,
    });
    tokens += cost;
  }
  return out;
}

/**
 * Build a compact index block for system-prompt injection: lists chunk ids +
 * titles so the LLM knows what topics it can pull in via the `lqc_knowledge`
 * tool. Deliberately does NOT inline every chunk — keeps the prompt small
 * and lets the model decide what to fetch.
 */
export function buildKnowledgeIndexBlock(opts = {}) {
  const doc = load(opts);
  if (doc.chunks.length === 0) return '';
  const lines = [
    '## LQCOUNCIL KNOWLEDGE (curated, authoritative)',
    'You are in an LQcouncil-bound group. Any question here is about LQcouncil unless explicitly scoped elsewhere.',
    'For specifics call the `lqc_knowledge` tool with the relevant topic id. Full content is distilled from the bot-council repo (CLAUDE.md, reference implementations, orchestrator source, live /bots/schema).',
    '',
    'Available topics:',
  ];
  for (const c of doc.chunks) {
    const kw = (c.keywords || []).slice(0, 3).join(', ');
    lines.push(`- \`${c.id}\` — ${c.title}${kw ? ` (keywords: ${kw})` : ''}`);
  }
  lines.push('');
  lines.push('Preferred behaviour in this group:');
  lines.push('- Reach for `lqc_*` tools and `lqc_knowledge` before `web_search` / `live_briefing`. LQcouncil is not a public project; the web knows nothing useful.');
  lines.push('- When the question is ambiguous about scope, assume it is about LQcouncil and proceed.');
  lines.push('- If a live fact is needed (current debates, bot status, health), use the corresponding `lqc_*` tool — `lqc_knowledge` is reference material, not live state.');
  return lines.join('\n');
}
