# Activity Router Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current indiscriminate EVO-first routing with activity-based classification that controls which tools, memories, and engine (EVO X2 vs Claude) each request gets.

**Architecture:** New `src/router.js` classifies each incoming message into one of 8 activity categories using keyword heuristics (fast, ~60-70% of messages) with LLM fallback (qwen3.5:35b on EVO X2, ~1s). Each category defines which tools are available, whether memories are fetched, and which engine handles the response. `claude.js` delegates routing decisions to the router instead of hardcoding EVO-first logic.

**Tech Stack:** Node.js ESM, Ollama `/api/chat` API (EVO X2), existing Anthropic SDK integration.

---

### Task 1: Create `src/router.js` — category definitions and tool maps

**Files:**
- Create: `src/router.js`

**Step 1: Create the router module with category constants and tool maps**

```javascript
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
```

**Step 2: Commit**

```bash
git add src/router.js
git commit -m "feat(router): add category definitions, tool maps, and routing rules"
```

---

### Task 2: Add keyword heuristic classifier to `src/router.js`

**Files:**
- Modify: `src/router.js`

**Step 1: Add the keyword classification function**

Append to `src/router.js`:

```javascript
// --- Layer 1: Keyword heuristics (instant, handles ~60-70% of messages) ---

const KEYWORD_RULES = [
  {
    category: CATEGORY.EMAIL,
    // Email ops + soul modifications — both Claude-only
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

  return null; // ambiguous or no match → LLM classifier
}
```

**Step 2: Commit**

```bash
git add src/router.js
git commit -m "feat(router): add keyword heuristic classifier (Layer 1)"
```

---

### Task 3: Add LLM classifier to `src/router.js`

**Files:**
- Modify: `src/router.js`

**Step 1: Add the LLM classification function**

Append to `src/router.js`:

```javascript
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
```

**Step 2: Commit**

```bash
git add src/router.js
git commit -m "feat(router): add LLM classifier via EVO X2 (Layer 2)"
```

---

### Task 4: Add the main `classifyMessage` entry point to `src/router.js`

**Files:**
- Modify: `src/router.js`

**Step 1: Add the combined classification function**

Append to `src/router.js`:

```javascript
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
```

**Step 2: Commit**

```bash
git add src/router.js
git commit -m "feat(router): add classifyMessage entry point with keyword-first, LLM-fallback"
```

---

### Task 5: Update `src/ollama.js` — accept filtered tools and remove `mustUseClaude`

**Files:**
- Modify: `src/ollama.js`

**Step 1: Remove `mustUseClaude` export and `CLAUDE_ONLY_TOOLS` set**

The router now handles this. Delete lines 19-23 (`CLAUDE_ONLY_TOOLS`) and lines 58-70 (`mustUseClaude` function).

**Step 2: Update `getEvoToolResponse` to accept pre-filtered tools**

Change the function signature and remove the internal tool filtering. The current line 76:

```javascript
const ollamaTools = toOllamaTools(tools.filter((t) => !CLAUDE_ONLY_TOOLS.has(t.name)));
```

Becomes:

```javascript
const ollamaTools = toOllamaTools(tools);
```

The tools are now pre-filtered by the router before being passed in.

**Step 3: Commit**

```bash
git add src/ollama.js
git commit -m "refactor(ollama): remove mustUseClaude and CLAUDE_ONLY_TOOLS — router handles this now"
```

---

### Task 6: Update `src/claude.js` — delegate to router

This is the main integration task. `getClawdResponse` currently has inline EVO-first logic with indiscriminate memory injection. Replace with router-driven flow.

**Files:**
- Modify: `src/claude.js`

**Step 1: Update imports**

Replace the ollama import (line 8):

```javascript
// Old:
import { mustUseClaude, getEvoToolResponse, checkEvoOllamaHealth } from './ollama.js';

// New:
import { getEvoToolResponse, checkEvoOllamaHealth } from './ollama.js';
import { classifyMessage, getToolsForCategory, needsMemories, mustUseClaude, CATEGORY } from './router.js';
```

**Step 2: Rewrite the routing logic in `getClawdResponse`**

Replace the current memory fetch block (lines 168-180) and EVO X2 block (lines 182-198) with:

```javascript
  // --- Activity-based routing ---
  const category = await classifyMessage(context, !!imageData);
  logger.info({ category, sender: senderJid }, 'routed');

  // Filter tools for this category
  const categoryTools = getToolsForCategory(category, tools);

  // Conditional memory fetch
  let memoryFragment = '';
  if (config.evoMemoryEnabled && needsMemories(category)) {
    try {
      const memories = await getRelevantMemories(context);
      memoryFragment = formatMemoriesForPrompt(memories);
      if (memories.length > 0) {
        logger.info({ count: memories.length, category }, 'memories injected');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'memory fetch failed');
    }
  }

  // Try EVO X2 for non-Claude categories
  if (!mustUseClaude(category) && config.evoToolEnabled && mode !== 'random' && !imageData) {
    try {
      const evoAvailable = await checkEvoOllamaHealth();
      if (evoAvailable) {
        const evoResponse = await getEvoToolResponse(context, categoryTools, senderJid, memoryFragment);
        if (evoResponse) {
          logger.info({ source: 'evo', category, chars: evoResponse.length }, 'responded via EVO X2');
          return evoResponse;
        }
        logger.warn('evo tool response was empty, falling back to Claude');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'evo tool call failed, falling back to Claude');
    }
  }
```

The Claude fallback block below remains unchanged, except it now uses `categoryTools` instead of `tools` for non-planning categories. For Claude categories (email, planning, general_knowledge), we pass the full category tools. The `cachedTools` line (currently line 203) changes from:

```javascript
const cachedTools = tools.map((t, i) => ...);
```

To:

```javascript
// For Claude fallback from EVO categories, use full tools. For Claude-native categories, use category tools.
const claudeTools = mustUseClaude(category) ? categoryTools : tools;
const cachedTools = claudeTools.map((t, i) =>
  i === claudeTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
);
```

**Step 3: Commit**

```bash
git add src/claude.js
git commit -m "feat(claude): integrate activity router — conditional tools, memories, and engine selection"
```

---

### Task 7: Update `src/ollama.js` — category-aware system prompt

**Files:**
- Modify: `src/ollama.js`

**Step 1: Add a category parameter to `buildEvoSystemPrompt`**

Update the function to accept a category and tailor the prompt:

```javascript
function buildEvoSystemPrompt(category = null) {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });

  let base = `You are Clawd, James's personal assistant on WhatsApp. Be concise and direct.

Today is ${dateStr}, ${timeStr} (Europe/London).`;

  // Category-specific instructions
  if (category === 'recall') {
    base += `\n\n## Rules
- Answer from the memories provided below. If no relevant memory exists, say "I don't have that stored."
- Do NOT guess or infer — only report what is in your memories.
- Keep messages short. Use bullet points. Bold key info with *asterisks*.`;
  } else if (category === 'conversational') {
    base += `\n\n## Rules
- Chat naturally. Be helpful, witty, concise.
- This is WhatsApp — keep it short.`;
  } else {
    // Tool-using categories (calendar, task, travel)
    base += `\n\n## Rules
- Use tools to answer questions. Do not guess — call the tool and report what it returns.
- For dates: compute relative dates from today. Use YYYY-MM-DD format. Use ISO 8601 for datetimes.
- UK train station CRS codes: KGX=Kings Cross, YRK=York, LDS=Leeds, EDB=Edinburgh, DAR=Darlington.

## Formatting tool results
- Report ONLY what the tool returned. Nothing more, nothing less.
- Use the EXACT titles, dates, times, and locations from the tool result.
- Do NOT add commentary, notes, warnings, or editorial observations about the data.
- Do NOT add suggestions or follow-up questions unless directly relevant.
- Do NOT invent, embellish, or infer any information not present in the tool result.
- Do NOT describe events as "continuing" or "recurring" unless the tool result explicitly says so.
- If an event spans multiple days, state the start and end date/time once — do not list it on each day.
- Keep messages short. Use bullet points. Bold key info with *asterisks*.
- This is WhatsApp — not an essay.`;
  }

  base += `\n\n## Memories
You may have background knowledge about James injected below. Use it to understand context (e.g. preferences, people, places) but do NOT mix memory facts into tool result summaries. Memories inform your understanding — tool results are the data you report.`;

  return base;
}
```

**Step 2: Update `getEvoToolResponse` to accept and pass category**

Change signature from:
```javascript
export async function getEvoToolResponse(context, tools, senderJid, memoryFragment = '')
```
To:
```javascript
export async function getEvoToolResponse(context, tools, senderJid, memoryFragment = '', category = null)
```

And update the system prompt line from:
```javascript
const systemPrompt = buildEvoSystemPrompt() + memoryFragment;
```
To:
```javascript
const systemPrompt = buildEvoSystemPrompt(category) + memoryFragment;
```

**Step 3: Update the call site in `claude.js`**

In the EVO X2 block, update the call from:
```javascript
const evoResponse = await getEvoToolResponse(context, categoryTools, senderJid, memoryFragment);
```
To:
```javascript
const evoResponse = await getEvoToolResponse(context, categoryTools, senderJid, memoryFragment, category);
```

**Step 4: Commit**

```bash
git add src/ollama.js src/claude.js
git commit -m "feat(ollama): category-aware system prompts — lean per-category instructions"
```

---

### Task 8: Verify and test

**Files:**
- Read: `src/router.js`, `src/claude.js`, `src/ollama.js`

**Step 1: Verify no syntax errors**

```bash
node --check src/router.js && node --check src/claude.js && node --check src/ollama.js
```

Expected: no output (clean parse).

**Step 2: Verify imports resolve**

```bash
node -e "import('./src/router.js').then(() => console.log('router OK')).catch(e => console.error(e))" --input-type=module
```

Expected: `router OK`

**Step 3: Test keyword classifier manually**

```bash
node --input-type=module -e "
import { classifyByKeywords } from './src/router.js';
const tests = [
  ['what\\'s on my calendar this week', 'calendar'],
  ['remind me to call the dentist', 'task'],
  ['check trains to york', 'travel'],
  ['email john about the meeting', 'email'],
  ['do you remember what I said about vanguard', null],
  ['what is the capital of france', 'general_knowledge'],
  ['hello clawd', null],
  ['check my calendar and email me a summary', null],
];
let pass = 0;
for (const [input, expected] of tests) {
  const result = classifyByKeywords(input);
  const ok = result === expected;
  if (ok) pass++;
  else console.log('FAIL:', input, 'expected:', expected, 'got:', result);
}
console.log(pass + '/' + tests.length + ' passed');
"
```

Expected: 8/8 passed (or close — adjust keyword patterns if any fail).

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix(router): adjust keyword patterns from test results"
```

---

### Task 9: Deploy to Pi and smoke test

**Step 1: Deploy changed files**

```bash
scp -i C:/Users/James/.ssh/id_ed25519 src/router.js pi@192.168.1.211:~/clawdbot/src/router.js
scp -i C:/Users/James/.ssh/id_ed25519 src/claude.js pi@192.168.1.211:~/clawdbot/src/claude.js
scp -i C:/Users/James/.ssh/id_ed25519 src/ollama.js pi@192.168.1.211:~/clawdbot/src/ollama.js
```

**Step 2: Restart service**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

**Step 3: Check logs for startup errors**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo journalctl -u clawdbot -n 30 --no-pager"
```

Expected: clean startup, no import errors.

**Step 4: Smoke test via WhatsApp**

Send these messages and verify routing:
1. "what's on my calendar this week" → should classify as `calendar`, no memories, EVO X2
2. "remind me to buy milk tomorrow" → should classify as `task`, no memories, EVO X2
3. "check trains to york for friday" → should classify as `travel`, preference memories only, EVO X2
4. "what is the population of york" → should classify as `general_knowledge`, no memories, Claude + web search
5. "do you remember what I said about the settlement" → should classify as `recall` (LLM classifier), memories = primary data

**Step 5: Commit final state**

```bash
git add -A
git commit -m "feat: activity-based message router — keyword-first, LLM-fallback classification"
```

---

### Task 10: Clean up old Ollama config from `src/config.js`

**Files:**
- Modify: `src/config.js`
- Modify: `.env.example`

**Step 1: Remove unused Pi local model config from `src/config.js`**

Delete these lines (44-50):
```javascript
  ollamaEnabled: process.env.OLLAMA_ENABLED === 'true',
  ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:1.5b',
  ollamaTimeout: parseInt(process.env.OLLAMA_TIMEOUT) || 15000,
  ollamaMaxTokens: parseInt(process.env.OLLAMA_MAX_TOKENS) || 300,
```

Keep `evoToolModel` and `evoToolEnabled` — those are the EVO X2 config.

**Step 2: Remove old Ollama env vars from `.env.example`**

Delete lines 41-44:
```
OLLAMA_ENABLED=false
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=qwen2.5:1.5b
OLLAMA_TIMEOUT=15000
OLLAMA_MAX_TOKENS=300
```

**Step 3: Remove the `ollamaEnabled` reference from `src/index.js` banner**

Line 38 references `config.ollamaEnabled`. Update the banner to show EVO X2 status instead:
```javascript
  EVO X2:   ${config.evoToolEnabled ? config.evoToolModel : 'disabled'}`;
```

**Step 4: Verify no remaining references to old config**

```bash
grep -r "ollamaEnabled\|ollamaHost\|ollamaModel\|ollamaTimeout\|ollamaMaxTokens" src/
```

Expected: no matches.

**Step 5: Commit**

```bash
git add src/config.js .env.example src/index.js
git commit -m "chore: remove unused Pi local Ollama config — EVO X2 is the only local model now"
```
