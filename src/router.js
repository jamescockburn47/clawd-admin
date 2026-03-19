// src/router.js — Smart activity-based message router
// Layers: complexity detection → keyword heuristics → LLM classifier → fallback
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { classifyViaEvo } from './evo-llm.js';

// Activity categories
export const CATEGORY = {
  CALENDAR: 'calendar',
  TASK: 'task',
  TRAVEL: 'travel',
  EMAIL: 'email',
  RECALL: 'recall',
  PLANNING: 'planning',
  CONVERSATIONAL: 'conversational',
  GENERAL_KNOWLEDGE: 'general_knowledge',
  SYSTEM: 'system',
};

// Tools available per category
const CATEGORY_TOOLS = {
  [CATEGORY.CALENDAR]: new Set([
    'calendar_list_events', 'calendar_create_event',
    'calendar_update_event', 'calendar_find_free_time',
  ]),
  [CATEGORY.TASK]: new Set([
    'todo_add', 'todo_list', 'todo_complete',
    'todo_remove', 'todo_update',
  ]),
  [CATEGORY.TRAVEL]: new Set([
    'train_departures', 'train_fares', 'hotel_search',
    'search_trains', 'search_accommodation',
  ]),
  [CATEGORY.EMAIL]: new Set([
    'gmail_search', 'gmail_read', 'gmail_draft', 'gmail_confirm_send',
    'soul_read', 'soul_propose', 'soul_confirm',
  ]),
  [CATEGORY.RECALL]: new Set([
    'memory_search', 'memory_update', 'memory_delete',
  ]),
  [CATEGORY.PLANNING]: null, // null = all tools
  [CATEGORY.CONVERSATIONAL]: new Set(), // empty = no tools
  [CATEGORY.GENERAL_KNOWLEDGE]: new Set(['web_search']),
  [CATEGORY.SYSTEM]: new Set(['system_status', 'memory_search']),
};

// --- Read/Write safety classification ---
// READ-SAFE: local model can handle these — low hallucination risk
const READ_SAFE_TOOLS = new Set([
  'todo_list', 'calendar_list_events', 'calendar_find_free_time',
  'memory_search', 'system_status', 'soul_read',
]);

// WRITE-DANGEROUS: must use Claude — hallucinated args cause real damage
const WRITE_DANGEROUS_TOOLS = new Set([
  'gmail_draft', 'gmail_confirm_send',
  'calendar_create_event', 'calendar_update_event',
  'soul_propose', 'soul_confirm',
  'memory_update', 'memory_delete',
]);

// Categories where tool calls are likely to be write/mutation operations
const WRITE_LIKELY_CATEGORIES = new Set([
  CATEGORY.EMAIL,
]);

// Categories where the message IMPLIES a write even if the category has read tools
function detectsWriteIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Calendar writes
  if (/\b(create|add|book|schedule|move|cancel|update|change|reschedule)\b/.test(lower)
    && /\b(event|meeting|appointment|calendar)\b/.test(lower)) return true;
  // Email writes
  if (/\b(send|draft|compose|write|reply|forward)\b/.test(lower)
    && /\b(email|mail|message)\b/.test(lower)) return true;
  // Todo mutations (these are safe for local, but let's be explicit)
  // todo_add/complete/remove are acceptable locally — excluded from dangerous
  return false;
}

// Categories that need memory injection
const MEMORY_CATEGORIES = new Set([
  CATEGORY.TRAVEL,
  CATEGORY.RECALL,
  CATEGORY.PLANNING,
  CATEGORY.SYSTEM,
]);

// Categories that must ALWAYS use Claude (not EVO X2)
const CLAUDE_CATEGORIES = new Set([
  CATEGORY.EMAIL,
  CATEGORY.PLANNING,
]);

// Filter tool definitions for a given category
export function getToolsForCategory(category, allTools) {
  const allowed = CATEGORY_TOOLS[category];
  if (allowed === null) return allTools; // planning = all tools
  return allTools.filter((t) => allowed.has(t.name));
}

// Should memories be fetched for this category?
export function needsMemories(category) {
  return MEMORY_CATEGORIES.has(category);
}

// --- Query complexity detection (pre-classifier) ---

function detectComplexity(text) {
  if (!text) return { complex: false, reason: null };
  const lower = text.toLowerCase();

  // Multi-step conjunctions: "check X and book Y", "find trains then accommodation"
  const conjunctions = (lower.match(/\b(and then|then|also|after that|as well|plus)\b/g) || []).length;
  if (conjunctions >= 2) return { complex: true, reason: 'multi-step (3+ conjunctions)' };

  // Long messages are usually complex
  if (text.length > 150) return { complex: true, reason: `long message (${text.length} chars)` };

  // Mixed intent: question + imperative
  const hasQuestion = /\b(what|when|how|where|who|which|is there|are there|can you)\b/.test(lower);
  const hasImperative = /\b(book|create|send|draft|add|update|schedule|find|search|check)\b/.test(lower);
  if (hasQuestion && hasImperative && conjunctions >= 1) {
    return { complex: true, reason: 'mixed question + imperative with conjunction' };
  }

  return { complex: false, reason: null };
}

// --- Layer 1: Keyword heuristics (instant, handles ~60-70% of messages) ---

const KEYWORD_RULES = [
  {
    category: CATEGORY.EMAIL,
    test: (lower) =>
      /\b(email|gmail|mail|inbox|draft|send an? email|reply to|forward)\b/.test(lower)
      || (/\b(soul|personality)\b/.test(lower) && /\b(change|update|modify|propose|set|adjust)\b/.test(lower)),
  },
  {
    category: CATEGORY.TASK,
    test: (lower) =>
      /\b(todo|to-do|to do list|remind me|add task|mark done|mark complete|my tasks|reminders)\b/.test(lower)
      || lower.startsWith('/todo'),
  },
  {
    category: CATEGORY.CALENDAR,
    test: (lower) =>
      /\b(calendar|diary|what'?s on|free time|schedule|book an? event|my week|my day|upcoming events|what am i doing|what have i got)\b/.test(lower),
  },
  {
    category: CATEGORY.TRAVEL,
    test: (lower) =>
      /\b(trains?|flights?|hotels?|travel|fares?|depart\w*|lner|airbnb|accommodation|booking|glamping|cottages?)\b/.test(lower),
  },
  {
    category: CATEGORY.SYSTEM,
    test: (lower) =>
      /\b(system status|architecture|how do(?:es)? (?:the |my )?(?:voice|whatsapp|dashboard|routing|evo|pi|system|pipeline))\b/.test(lower)
      || /\b(what(?:'s| is) running|what services|what components|system report|status report)\b/.test(lower)
      || /\b(what changed|changelog|what version|current version|deployment|what(?:'s| is) deployed)\b/.test(lower)
      || /\b(how are you running|how do you work|what are you running on|tell me about yourself)\b/.test(lower)
      || /\b(evo x2|ollama|whisper model|voice listener|noise suppression)\b/.test(lower),
  },
  {
    category: CATEGORY.GENERAL_KNOWLEDGE,
    test: (lower) =>
      /^(search for|google|look up|what is|who is|how does|how do you|how much does|where is|when did)\b/.test(lower)
      || /\b(search the web|web search|look this up)\b/.test(lower),
  },
];

// --- Dynamically loaded learned rules (from self-improvement cycle) ---
let LEARNED_RULES = [];
let _learnedRulesLoadedAt = 0;
const LEARNED_RULES_FILE = join('data', 'learned-rules.json');

export function reloadLearnedRules() {
  try {
    if (!existsSync(LEARNED_RULES_FILE)) { LEARNED_RULES = []; _learnedRulesLoadedAt = Date.now(); return; }
    const data = JSON.parse(readFileSync(LEARNED_RULES_FILE, 'utf-8'));
    LEARNED_RULES = (data.rules || [])
      .filter(r => r.approved !== false)
      .map(r => ({
        category: r.category,
        test: (lower) => new RegExp(r.pattern).test(lower),
        source: 'learned',
        id: r.id,
      }));
    _learnedRulesLoadedAt = Date.now();
    if (LEARNED_RULES.length > 0) {
      logger.info({ count: LEARNED_RULES.length }, 'learned rules loaded');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to load learned rules');
    LEARNED_RULES = [];
  }
}

function ensureLearnedRulesLoaded() {
  if (Date.now() - _learnedRulesLoadedAt > 300000) reloadLearnedRules(); // 5 min refresh
}

// Initial load
reloadLearnedRules();

// Returns category or null if no confident keyword match
export function classifyByKeywords(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  ensureLearnedRulesLoaded();

  const allRules = [...KEYWORD_RULES, ...LEARNED_RULES];
  const matches = allRules.filter((r) => r.test(lower));

  // Deduplicate by category — multiple rules for the same category is fine
  const categories = [...new Set(matches.map(r => r.category))];

  // Only return if exactly one CATEGORY matched — ambiguity defers to LLM
  if (categories.length === 1) return categories[0];

  return null; // ambiguous or no match -> LLM classifier
}

// --- Layer 2: LLM classifier via EVO X2 (handles ambiguous messages) ---

const VALID_CATEGORIES = new Set(Object.values(CATEGORY));

const CLASSIFY_PROMPT = `Classify this WhatsApp message into exactly one category.
Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge, system

Rules:
- "calendar" = checking schedule, creating/updating events, what's on, free time
- "task" = todos, reminders, task lists
- "travel" = trains, hotels, flights, fares, accommodation, booking trips
- "email" = reading/sending/drafting emails, inbox, gmail
- "recall" = asking about something previously discussed, stored facts, "do you remember", "what did I say about"
- "planning" = complex multi-step reasoning, organising something that needs tools AND context
- "conversational" = chat, banter, greetings, opinions, no tools needed
- "general_knowledge" = factual questions, current info, web lookups, "what is X", "who is Y"
- "system" = questions about the bot itself, its architecture, status, services, voice pipeline, what's running, what changed, deployments, components

Reply with ONLY the category name. Nothing else.`;

// Circuit breaker — skip EVO after repeated failures instead of blocking every message
const circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  openUntil: 0,
  THRESHOLD: 3,        // open after 3 consecutive failures
  COOLDOWN_MS: 30000,  // stay open for 30s before retrying
  WINDOW_MS: 60000,    // reset failure count after 60s of no failures

  isOpen() {
    if (Date.now() < this.openUntil) return true;
    // Reset if enough time passed since last failure
    if (this.failures > 0 && Date.now() - this.lastFailure > this.WINDOW_MS) {
      this.failures = 0;
    }
    return false;
  },

  recordSuccess() {
    this.failures = 0;
  },

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.THRESHOLD) {
      this.openUntil = Date.now() + this.COOLDOWN_MS;
      logger.warn({ failures: this.failures, cooldownMs: this.COOLDOWN_MS }, 'EVO circuit breaker opened');
    }
  },
};

export async function classifyByLLM(text) {
  // Circuit breaker: skip if EVO has been failing
  if (circuitBreaker.isOpen()) {
    logger.debug('EVO circuit breaker open, skipping LLM classifier');
    return null;
  }

  try {
    const raw = await classifyViaEvo(text, CLASSIFY_PROMPT);

    if (raw && VALID_CATEGORIES.has(raw)) {
      circuitBreaker.recordSuccess();
      logger.info({ category: raw, source: 'llm_classifier' }, 'message classified');
      return raw;
    }

    logger.warn({ raw, text: text.slice(0, 80) }, 'LLM classifier returned invalid category');
    circuitBreaker.recordFailure();
    return null;
  } catch (err) {
    circuitBreaker.recordFailure();
    logger.warn({ err: err.message }, 'LLM classifier failed');
    return null;
  }
}

// --- Main classification entry point ---
// Returns a rich routing decision object

export async function classifyMessage(text, hasImage) {
  // Images always go to Claude with full context (planning)
  if (hasImage) {
    logger.info({ category: CATEGORY.PLANNING, source: 'image' }, 'message classified');
    return {
      category: CATEGORY.PLANNING,
      source: 'image',
      forceClaude: true,
      reason: 'image input requires Claude vision',
    };
  }

  // Pre-check: complexity detection (before any classification)
  const complexity = detectComplexity(text);
  if (complexity.complex) {
    logger.info({ category: CATEGORY.PLANNING, source: 'complexity', reason: complexity.reason }, 'message classified');
    return {
      category: CATEGORY.PLANNING,
      source: 'complexity',
      forceClaude: true,
      reason: complexity.reason,
    };
  }

  // Layer 1: keyword heuristics
  const keywordResult = classifyByKeywords(text);
  if (keywordResult) {
    const writeIntent = detectsWriteIntent(text);
    const forceClaude = CLAUDE_CATEGORIES.has(keywordResult)
      || WRITE_LIKELY_CATEGORIES.has(keywordResult)
      || writeIntent;

    logger.info({ category: keywordResult, source: 'keywords', forceClaude, writeIntent }, 'message classified');
    return {
      category: keywordResult,
      source: 'keywords',
      forceClaude,
      reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null),
    };
  }

  // Layer 2: LLM classifier
  const llmResult = await classifyByLLM(text);
  if (llmResult) {
    const writeIntent = detectsWriteIntent(text);
    const forceClaude = CLAUDE_CATEGORIES.has(llmResult)
      || WRITE_LIKELY_CATEGORIES.has(llmResult)
      || writeIntent;

    return {
      category: llmResult,
      source: 'llm_classifier',
      forceClaude,
      reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null),
    };
  }

  // Fallback: planning (Claude + all tools + memories) — safest default
  logger.info({ category: CATEGORY.PLANNING, source: 'fallback' }, 'message classified');
  return {
    category: CATEGORY.PLANNING,
    source: 'fallback',
    forceClaude: true,
    reason: 'no confident classification',
  };
}

// Must this category use Claude? (legacy compat — prefer route.forceClaude)
export function mustUseClaude(category) {
  return CLAUDE_CATEGORIES.has(category);
}

// Exported for tool validation in ollama.js
export { READ_SAFE_TOOLS, WRITE_DANGEROUS_TOOLS };

// Exported for eval suite and self-improvement
export { detectComplexity, detectsWriteIntent, KEYWORD_RULES, CLAUDE_CATEGORIES, WRITE_LIKELY_CATEGORIES };
