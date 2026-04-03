// src/cortex.js — Two-phase parallel intelligence gathering
//
// Phase 1 (fast): Classify + identity in parallel (~200ms)
// Phase 2 (category-aware): Based on classification, fire only the streams
//   that matter for this category, with intelligent token budget allocation.
//
// This is NOT a race — it's a broad net that gathers selectively, then
// assembles the results in priority order with per-section budgets.
//
// Design constraints:
// - No extra Opus/Claude calls (cost-neutral)
// - All local or free services (EVO classifier, memory, SearXNG)
// - Each stream fails independently
// - Category determines what fires, not a blind scatter

import config from './config.js';
import { classifyMessage } from './router.js';
import { needsMemories, CATEGORY } from './router.js';
import {
  getRelevantMemories, formatMemoriesForPrompt, searchMemory,
  getIdentityMemories, getInsightMemories,
} from './memory.js';
import { warmFromQuery, getWorkingKnowledge } from './lquorum-rag.js';
import { getLiveSystemSnapshot } from './system-knowledge.js';
import { webSearch } from './tools/search.js';
import logger from './logger.js';

// Categories where web prefetch is worth the cost (SearXNG is free, just latency)
const WEB_LIKELY = new Set([
  CATEGORY.GENERAL_KNOWLEDGE,
  CATEGORY.PLANNING,
  CATEGORY.RECALL,
]);

// Quick heuristic: does the message look like it wants current info?
const WEB_HINT_PATTERN = /\b(search|google|look up|find out|latest|current|recent|news|price|weather|score|result|today|who is|what is|when is|where is)\b/i;

// Categories that benefit from dream context
const DREAM_CATEGORIES = new Set([
  CATEGORY.RECALL, CATEGORY.PLANNING, CATEGORY.CONVERSATIONAL,
  CATEGORY.GENERAL_KNOWLEDGE, CATEGORY.SYSTEM,
]);

// Categories that benefit from insight context
const INSIGHT_CATEGORIES = new Set([
  CATEGORY.RECALL, CATEGORY.PLANNING, CATEGORY.GENERAL_KNOWLEDGE,
]);

// Per-section character budgets (sum should be <= TOTAL_BUDGET)
// Ordered by priority — higher priority sections get their full budget first
const TOTAL_BUDGET = 12000;
const SECTION_BUDGETS = {
  identity: 2000,     // always, non-negotiable
  relevant: 5000,     // highest value when present
  dreams: 1500,       // recent experience context
  insights: 1000,     // cross-conversation patterns
  lquorum: 1500,      // working knowledge
  system: 2000,       // only for SYSTEM queries
};

/**
 * Two-phase intelligence gathering.
 *
 * Phase 1: Classify + identity (parallel, ~200ms)
 * Phase 2: Category-aware streams (parallel, ~500-1500ms depending on what fires)
 *
 * @param {string} context
 * @param {boolean} hasImage
 * @param {boolean} isGroup
 * @param {object} options  — { secretaryMode }
 * @returns {object} { route, memoryFragment, webPrefetch }
 */
export async function gatherIntelligence(context, hasImage, isGroup, options = {}) {
  const t0 = Date.now();

  // ── Phase 1: Classification + identity (always needed, both fast) ──
  const [route, identityMems] = await Promise.all([
    classifyMessage(context, hasImage, isGroup),
    config.evoMemoryEnabled
      ? getIdentityMemories().catch(err => {
          logger.warn({ err: err.message }, 'cortex: identity fetch failed');
          return [];
        })
      : [],
  ]);

  if (options.secretaryMode) {
    route.needsPlan = false;
    route.planReason = null;
  }

  const { category } = route;
  const phase1Ms = Date.now() - t0;

  // ── Phase 2: Category-aware stream selection ──
  // Only fire what this category actually needs.
  const streams = {};

  // LQuorum — synchronous, near-instant, always worth doing
  warmFromQuery(context);

  // Relevant memories — only for categories that use them
  if (config.evoMemoryEnabled && needsMemories(category)) {
    streams.relevant = getRelevantMemories(context).catch(err => {
      logger.warn({ err: err.message }, 'cortex: relevant memories failed');
      return [];
    });
  }

  // Dreams — only for categories where experience context helps
  const isDreamQuery = /\b(dream|diary|dreamt|dreamed|last night|overnight)\b/i.test(context);
  if (config.evoMemoryEnabled && config.dreamModeEnabled
      && (isDreamQuery || DREAM_CATEGORIES.has(category))) {
    const dreamLimit = isDreamQuery ? 5 : 2;
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const dreamQuery = isDreamQuery ? `dream diary ${yesterday}` : 'dream summary recent';
    streams.dreams = searchMemory(dreamQuery, 'dream', dreamLimit).catch(err => {
      logger.warn({ err: err.message }, 'cortex: dream memories failed');
      return [];
    });
  }

  // Insights — only for categories where cross-conversation patterns help
  if (config.evoMemoryEnabled && INSIGHT_CATEGORIES.has(category)) {
    streams.insights = getInsightMemories(context, 3).catch(err => {
      logger.warn({ err: err.message }, 'cortex: insight memories failed');
      return [];
    });
  }

  // System snapshot — only for SYSTEM queries
  if (category === CATEGORY.SYSTEM) {
    streams.system = getLiveSystemSnapshot().catch(err => {
      logger.warn({ err: err.message }, 'cortex: system snapshot failed');
      return '';
    });
  }

  // Speculative web prefetch — if heuristic or category suggests it
  const webHint = WEB_HINT_PATTERN.test(context);
  if (webHint || WEB_LIKELY.has(category)) {
    streams.webPrefetch = speculativeWebSearch(context).catch(() => null);
  }

  // ── Await phase 2 streams ──
  const keys = Object.keys(streams);
  const values = await Promise.all(Object.values(streams));
  const results = {};
  keys.forEach((k, i) => { results[k] = values[i]; });

  const phase2Ms = Date.now() - t0 - phase1Ms;

  // ── Assemble memory fragment with budget-aware prioritisation ──
  const sections = [];
  let usedBudget = 0;

  // Identity — always first, highest priority
  if (identityMems.length > 0) {
    const idText = `## Who I am\n${identityMems.map(m => `- ${m.fact}`).join('\n')}`;
    const capped = capSection(idText, SECTION_BUDGETS.identity);
    sections.push(capped);
    usedBudget += capped.length;
  }

  // Relevant memories — most valuable when present
  if (results.relevant?.length > 0) {
    const memText = formatMemoriesForPrompt(results.relevant);
    const budget = Math.min(SECTION_BUDGETS.relevant, TOTAL_BUDGET - usedBudget);
    const capped = capSection(memText, budget);
    sections.push(capped);
    usedBudget += capped.length;
    logger.info({ count: results.relevant.length, category }, 'cortex: memories injected');
  }

  // Dreams — experience context
  if (results.dreams) {
    const dreamMems = results.dreams.map(r => r.memory || r).filter(Boolean);
    if (dreamMems.length > 0) {
      const header = isDreamQuery
        ? '## My diary entries (dream mode summaries)'
        : '## Recent experiences (dream summaries)';
      const dreamText = `${header}\n${dreamMems.map(d => `- ${d.fact}`).join('\n')}`;
      const budget = Math.min(SECTION_BUDGETS.dreams, TOTAL_BUDGET - usedBudget);
      const capped = capSection(dreamText, budget);
      sections.push(capped);
      usedBudget += capped.length;
      logger.info({ count: dreamMems.length, explicit: isDreamQuery }, 'cortex: dreams injected');
    }
  }

  // Insights — cross-conversation patterns
  if (results.insights?.length > 0) {
    const insightText = `## Prior insights\n${results.insights.map(m => `- ${m.fact}`).join('\n')}`;
    const budget = Math.min(SECTION_BUDGETS.insights, TOTAL_BUDGET - usedBudget);
    const capped = capSection(insightText, budget);
    sections.push(capped);
    usedBudget += capped.length;
  }

  // LQuorum working knowledge
  const lquorumContext = getWorkingKnowledge();
  if (lquorumContext) {
    const budget = Math.min(SECTION_BUDGETS.lquorum, TOTAL_BUDGET - usedBudget);
    const capped = capSection(lquorumContext, budget);
    sections.push(capped);
    usedBudget += capped.length;
  }

  // System snapshot
  if (results.system) {
    const budget = Math.min(SECTION_BUDGETS.system, TOTAL_BUDGET - usedBudget);
    const capped = capSection(results.system, budget);
    sections.push(capped);
    usedBudget += capped.length;
  }

  const memoryFragment = sections.join('\n\n');

  const elapsed = Date.now() - t0;
  const streamsLog = {
    identity: identityMems.length,
    relevant: results.relevant?.length || 0,
    dreams: results.dreams ? (results.dreams.map(r => r.memory || r).filter(Boolean)).length : 0,
    insights: results.insights?.length || 0,
    lquorum: !!lquorumContext,
    webPrefetch: !!results.webPrefetch,
  };

  // Count how many streams were skipped by category gating
  const skipped = ['relevant', 'dreams', 'insights', 'system', 'webPrefetch']
    .filter(k => !(k in streams)).length;

  logger.info({
    category, source: route.source,
    phase1Ms, phase2Ms, elapsed,
    streams: streamsLog,
    skipped,
    budgetUsed: usedBudget,
  }, 'cortex: intelligence gathered');

  return { route, memoryFragment, webPrefetch: results.webPrefetch || null, timing: { phase1Ms, phase2Ms, totalMs: elapsed } };
}

/**
 * Cap a section's text to a character budget, cutting at the last complete line.
 */
function capSection(text, budget) {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > budget * 0.3 ? cut.slice(0, lastNewline) : cut;
}


// ── Speculative web prefetch ──

const _webCache = new Map();
const WEB_CACHE_MAX = 20;
const WEB_CACHE_TTL = 60_000;

function _webCacheKey(text) {
  return text.slice(0, 100).trim().toLowerCase();
}

async function speculativeWebSearch(context) {
  const key = _webCacheKey(context);

  const cached = _webCache.get(key);
  if (cached && Date.now() - cached.ts < WEB_CACHE_TTL) {
    return cached.result;
  }

  let query = context;
  const currentIdx = context.lastIndexOf('[Current message]');
  if (currentIdx !== -1) {
    query = context.slice(currentIdx + 17).trim();
  }
  query = query.replace(/^\w+:\s*/, '');
  query = query.slice(0, 200).trim();

  if (query.length < 5) return null;

  const result = await webSearch({ query, count: 5 });

  if (_webCache.size >= WEB_CACHE_MAX) {
    const oldest = _webCache.keys().next().value;
    _webCache.delete(oldest);
  }
  _webCache.set(key, { result, ts: Date.now() });

  logger.info({ queryLen: query.length }, 'cortex: speculative web prefetch complete');
  return result;
}

/**
 * Check the web prefetch cache for a query similar to what the LLM requested.
 */
export function getWebPrefetch(query) {
  for (const [key, entry] of _webCache.entries()) {
    if (Date.now() - entry.ts > WEB_CACHE_TTL) {
      _webCache.delete(key);
      continue;
    }
    const queryWords = new Set(query.toLowerCase().split(/\W+/).filter(w => w.length > 2));
    const keyWords = new Set(key.split(/\W+/).filter(w => w.length > 2));
    let overlap = 0;
    for (const w of queryWords) {
      if (keyWords.has(w)) overlap++;
    }
    if (queryWords.size > 0 && overlap / queryWords.size >= 0.5) {
      logger.info({ overlap: `${overlap}/${queryWords.size}` }, 'cortex: web prefetch cache hit');
      return entry.result;
    }
  }
  return null;
}
