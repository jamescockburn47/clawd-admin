// src/router.js — Activity-based message router
import config from './config.js';
import logger from './logger.js';

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
};

// Categories that need memory injection
const MEMORY_CATEGORIES = new Set([
  CATEGORY.TRAVEL,
  CATEGORY.RECALL,
  CATEGORY.PLANNING,
]);

// Categories that must use Claude (not EVO X2)
const CLAUDE_CATEGORIES = new Set([
  CATEGORY.EMAIL,
  CATEGORY.PLANNING,
  CATEGORY.GENERAL_KNOWLEDGE,
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

// Must this category use Claude?
export function mustUseClaude(category) {
  return CLAUDE_CATEGORIES.has(category);
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
      /\b(train|flight|hotel|travel|fare|depart|lner|airbnb|accommodation|booking|glamping|cottage)\b/.test(lower),
  },
  {
    category: CATEGORY.GENERAL_KNOWLEDGE,
    test: (lower) =>
      /^(search for|google|look up|what is|who is|how does|how do you|how much does|where is|when did)\b/.test(lower)
      || /\b(search the web|web search|look this up)\b/.test(lower),
  },
];

// Returns category or null if no confident keyword match
export function classifyByKeywords(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  const matches = KEYWORD_RULES.filter((r) => r.test(lower));

  // Only return if exactly one category matched — ambiguity defers to LLM
  if (matches.length === 1) return matches[0].category;

  return null; // ambiguous or no match -> LLM classifier
}

// --- Layer 2: LLM classifier via EVO X2 (handles ambiguous messages) ---

const VALID_CATEGORIES = new Set(Object.values(CATEGORY));

const CLASSIFY_PROMPT = `Classify this WhatsApp message into exactly one category.
Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge

Rules:
- "calendar" = checking schedule, creating/updating events, what's on, free time
- "task" = todos, reminders, task lists
- "travel" = trains, hotels, flights, fares, accommodation, booking trips
- "email" = reading/sending/drafting emails, inbox, gmail
- "recall" = asking about something previously discussed, stored facts, "do you remember", "what did I say about"
- "planning" = complex multi-step reasoning, organising something that needs tools AND context
- "conversational" = chat, banter, greetings, opinions, no tools needed
- "general_knowledge" = factual questions, current info, web lookups, "what is X", "who is Y"

Reply with ONLY the category name. Nothing else.`;

export async function classifyByLLM(text) {
  const evoOllamaUrl = config.evoMemoryUrl.replace(':5100', ':11434');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${evoOllamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.evoToolModel,
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: text },
        ],
        stream: false,
        think: false,
        keep_alive: -1,
        options: { temperature: 0, num_predict: 10 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const data = await res.json();
    const raw = (data.message?.content || '').trim().toLowerCase().replace(/[^a-z_]/g, '');

    if (VALID_CATEGORIES.has(raw)) {
      logger.info({ category: raw, source: 'llm_classifier' }, 'message classified');
      return raw;
    }

    logger.warn({ raw, text: text.slice(0, 80) }, 'LLM classifier returned invalid category');
    return null;
  } catch (err) {
    clearTimeout(timeoutId);
    logger.warn({ err: err.message }, 'LLM classifier failed');
    return null;
  }
}

// --- Main classification entry point ---

export async function classifyMessage(text, hasImage) {
  // Images always go to Claude with full context (planning)
  if (hasImage) {
    logger.info({ category: CATEGORY.PLANNING, source: 'image' }, 'message classified');
    return CATEGORY.PLANNING;
  }

  // Layer 1: keyword heuristics
  const keywordResult = classifyByKeywords(text);
  if (keywordResult) {
    logger.info({ category: keywordResult, source: 'keywords' }, 'message classified');
    return keywordResult;
  }

  // Layer 2: LLM classifier
  const llmResult = await classifyByLLM(text);
  if (llmResult) return llmResult;

  // Fallback: planning (Claude + all tools + memories) — safest default
  logger.info({ category: CATEGORY.PLANNING, source: 'fallback' }, 'message classified');
  return CATEGORY.PLANNING;
}
