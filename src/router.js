// src/router.js — Smart activity-based message router
// Layers: complexity detection → keyword heuristics → LLM classifier → fallback
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { classifyViaEvo, classifyVia4B } from './evo-llm.js';
import { CATEGORY } from './constants.js';
import { plannerBreaker } from './evo-client.js';

// Re-export CATEGORY so existing consumers don't break
export { CATEGORY };

// Tools available per category
// NOTE: web_search and web_fetch are ALWAYS injected into every category
// (see getToolsForCategory). This ensures Claude can ALWAYS search the web
// when the prompt mandates it — no stale training data should ever leak.
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

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
  ]),
  [CATEGORY.RECALL]: new Set([
    'memory_search', 'memory_update', 'memory_delete',
    'project_list', 'project_read', 'project_pitch',
    'overnight_report',
  ]),
  [CATEGORY.PLANNING]: null, // null = all tools
  [CATEGORY.CONVERSATIONAL]: new Set(), // web tools added dynamically below
  [CATEGORY.GENERAL_KNOWLEDGE]: new Set(['web_search', 'web_fetch']),
  [CATEGORY.SYSTEM]: new Set(['system_status', 'memory_search', 'overnight_report']),
};

// --- Read/Write safety classification ---
// READ-SAFE: local model can handle these — low hallucination risk
const READ_SAFE_TOOLS = new Set([
  'todo_list', 'calendar_list_events', 'calendar_find_free_time',
  'memory_search', 'system_status', 'soul_read',
  'project_list', 'project_read', 'project_pitch',
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
  CATEGORY.RECALL,
  CATEGORY.SYSTEM,
]);

// Filter tool definitions for a given category
// Always includes web_search + web_fetch so Claude can ALWAYS search
export function getToolsForCategory(category, allTools) {
  const allowed = CATEGORY_TOOLS[category];
  if (allowed === null) return allTools; // planning = all tools
  // Merge category-specific tools with web tools (always available)
  return allTools.filter((t) => allowed.has(t.name) || WEB_TOOLS.has(t.name));
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

  // Very long messages with action verbs are usually complex
  // (Raised from 150 — conversational messages in groups are often 150-400 chars)
  if (text.length > 400) return { complex: true, reason: `long message (${text.length} chars)` };

  // Mixed intent: question + imperative
  const hasQuestion = /\b(what|when|how|where|who|which|is there|are there|can you)\b/.test(lower);
  const hasImperative = /\b(book|create|send|draft|add|update|schedule|find|search|check)\b/.test(lower);
  if (hasQuestion && hasImperative && conjunctions >= 1) {
    return { complex: true, reason: 'mixed question + imperative with conjunction' };
  }

  return { complex: false, reason: null };
}

// --- Plan signal heuristic (lightweight check before calling 4B for needsPlan) ---

function mightNeedPlan(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Overview/briefing requests — inherently multi-source
  if (/\b(this week|next week|prepare|get ready|brief me|catch me up|what's outstanding|what do i need|what have i got on|status update|overview|what's happening)\b/.test(lower)) return true;

  // Cross-domain signals — combining different tool domains
  if (/\b(and also|and then|then also|as well as|plus|after that)\b/.test(lower)) return true;

  // Preparation/readiness signals
  if (/\b(prepare|ready for|get sorted|make sure|ensure)\b/.test(lower)) return true;

  // Multiple action verbs in one message
  const actions = lower.match(/\b(check|find|search|add|create|send|book|list|get|prepare|review|draft|update|look up|remind)\b/g);
  if (actions && new Set(actions).size >= 2) return true;

  return false;
}

// --- Layer 1: Keyword heuristics (instant, handles ~60-70% of messages) ---

const KEYWORD_RULES = [
  {
    category: CATEGORY.RECALL,
    test: (lower) =>
      /\b(dream|diary|dreamt|dreamed|last night|overnight|overnight.*report)\b/.test(lower)
      && /\b(tell|what|about|how|show|recall|review|read|describe|share|report|regenerate|resend|send|generate)\b/.test(lower),
  },
  {
    category: CATEGORY.PLANNING,
    test: (lower) =>
      /\b(soul|personality)\b/.test(lower) && /\b(change|update|modify|propose|set|adjust|learn|forget|remove)\b/.test(lower),
  },
  {
    category: CATEGORY.PLANNING,
    test: (lower) =>
      /\b(project|pitch|atlas|clawd.?agi)\b/.test(lower),
  },
  {
    category: CATEGORY.PLANNING,
    test: (lower) =>
      /\b(self.?program|self.?cod|evolution|evolve|tweak.*classif|fix.*yourself|upgrade.*yourself|improve.*yourself|recode|reprogram)\b/.test(lower),
  },
  {
    category: CATEGORY.EMAIL,
    test: (lower) =>
      // Require email keywords with action intent, or explicit email tool words.
      // "his email" or "an email" in passing context should NOT trigger email category.
      (/\b(gmail|inbox|draft an? email|send an? email|reply to .* email|forward .* email|compose)\b/.test(lower))
      || (/\b(email|mail)\b/.test(lower) && /\b(check|read|search|send|draft|compose|write|reply|forward)\b/.test(lower)),
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
      || /\b(self[- ]?aware|know yourself|what are you|who are you as a system)\b/.test(lower)
      || /\b(evo x2|ollama|llama-server|whisper model|voice listener|noise suppression)\b/.test(lower)
      || /\b(agi|your (?:plan|roadmap|capabilities|functions|features|progress)|how far along|what can you do|what do you do)\b/.test(lower)
      || /\b(your evolution|your dream|your soul|your memory|your diary|overnight (?:report|coding|learning))\b/.test(lower)
      || /\b(how (?:do|does) (?:clawd|you) (?:work|learn|think|evolve|improve|dream))\b/.test(lower)
      || /\b(tell me (?:about|what) you(?:rself)?|describe yourself|explain yourself|what(?:'s| is) your status)\b/.test(lower),
  },
  {
    category: CATEGORY.GENERAL_KNOWLEDGE,
    test: (lower) =>
      /^(search for|google|look up|what is|who is|how does|how do you|how much does|where is|when did|when was|when is|when does)\b/.test(lower)
      || /\b(search the web|web search|look this up)\b/.test(lower)
      || /\b(tell me about|explain|latest news|current price|is .{2,30} legal|how many|how much|what happened|what\'s happening|what are the|who founded|who started|who owns|what year|what date|which country)\b/.test(lower)
      || /\b(compare|difference between|pros and cons|best .{2,30} for|top \d|versus|vs\b)/.test(lower),
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

export async function classifyMessage(text, hasImage, isGroup = false) {
  // Images — EVO VL model handles locally when available, Claude as fallback
  if (hasImage) {
    logger.info({ category: CATEGORY.PLANNING, source: 'image' }, 'message classified');
    return {
      category: CATEGORY.PLANNING,
      source: 'image',
      forceClaude: false,
      reason: 'image input — EVO VL model preferred',
      needsPlan: false,
      planReason: null,
      confidence: null,
    };
  }

  // Layer 1: keyword heuristics (run FIRST — specific matches beat generic complexity)
  const keywordResult = classifyByKeywords(text);
  if (keywordResult) {
    const writeIntent = detectsWriteIntent(text);
    let forceClaude = CLAUDE_CATEGORIES.has(keywordResult)
      || WRITE_LIKELY_CATEGORIES.has(keywordResult)
      || writeIntent;

    // Always evaluate needsPlan via 4B — keywords determine category, 4B determines complexity
    let needsPlan = false;
    let planReason = null;
    let confidence = null;

    if (mightNeedPlan(text)) {
      const classResult = await plannerBreaker.call(() => classifyVia4B(text), null);
      if (classResult) {
        needsPlan = classResult.needsPlan || false;
        planReason = classResult.planReason || null;
        confidence = classResult.confidence || null;
        if (needsPlan) forceClaude = true;
      }
    }

    logger.info({ category: keywordResult, source: 'keywords', forceClaude, writeIntent, needsPlan, planReason }, 'message classified');
    return {
      category: needsPlan ? CATEGORY.PLANNING : keywordResult, // upgrade to PLANNING if plan needed
      source: 'keywords',
      forceClaude,
      reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null),
      needsPlan,
      planReason,
      confidence,
    };
  }

  // Layer 2: complexity detection (after keywords — catches multi-step/long messages
  // that didn't match any specific keyword pattern)
  const complexity = detectComplexity(text);
  if (complexity.complex) {
    logger.info({ category: CATEGORY.PLANNING, source: 'complexity', reason: complexity.reason }, 'message classified');
    return {
      category: CATEGORY.PLANNING,
      source: 'complexity',
      forceClaude: true,
      reason: complexity.reason,
      needsPlan: false, // complexity detection doesn't determine needsPlan — 4B does that
      planReason: null,
      confidence: null,
    };
  }

  // Layer 3: 4B classifier (category + needsPlan) — replaces the 0.6B for routing
  const classResult = await plannerBreaker.call(() => classifyVia4B(text), null);
  if (classResult && VALID_CATEGORIES.has(classResult.category)) {
    const writeIntent = detectsWriteIntent(text);
    const forceClaude = CLAUDE_CATEGORIES.has(classResult.category)
      || WRITE_LIKELY_CATEGORIES.has(classResult.category)
      || writeIntent
      || classResult.needsPlan; // planning always uses cloud model

    logger.info({
      category: classResult.category,
      source: '4b_classifier',
      forceClaude,
      needsPlan: classResult.needsPlan,
      planReason: classResult.planReason,
      confidence: classResult.confidence,
    }, 'message classified');

    return {
      category: classResult.category,
      source: '4b_classifier',
      forceClaude,
      reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null),
      needsPlan: classResult.needsPlan || false,
      planReason: classResult.planReason || null,
      confidence: classResult.confidence || null,
    };
  }

  // Layer 4: Legacy 0.6B LLM classifier (fallback if 4B unavailable)
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
      needsPlan: false,
      planReason: null,
      confidence: null,
    };
  }

  // Fallback: PLANNING with Claude.
  logger.info({ category: CATEGORY.PLANNING, source: 'fallback', isGroup }, 'message classified');
  return {
    category: CATEGORY.PLANNING,
    source: 'fallback',
    forceClaude: true,
    reason: 'no confident classification',
    needsPlan: false,
    planReason: null,
    confidence: null,
  };
}

// Must this category use Claude? (legacy compat — prefer route.forceClaude)
export function mustUseClaude(category) {
  return CLAUDE_CATEGORIES.has(category);
}

// Exported for router eval / tooling (not used by runtime LLM path)
export { READ_SAFE_TOOLS, WRITE_DANGEROUS_TOOLS };

// Exported for eval suite and self-improvement
export { detectComplexity, detectsWriteIntent, KEYWORD_RULES, CLAUDE_CATEGORIES, WRITE_LIKELY_CATEGORIES };
