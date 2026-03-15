# Activity Router Design

## Problem

Messages are routed EVO X2-first with all tools and all memories injected indiscriminately. This causes:
- Irrelevant memories polluting tool-based responses (calendar queries get settlement deadline memories)
- Local model overwhelmed by tools it doesn't need for the request
- No distinction between request types that need Claude (email, complex reasoning) and those that don't

## Design

### Activity Categories

| Category | Memories | Tools | Engine | Notes |
|----------|----------|-------|--------|-------|
| **calendar** | No | calendar_* | EVO X2 | Prospective only |
| **task** | No | todo_* | EVO X2 | CRUD operations |
| **travel** | Preferences only | train/hotel/fare | EVO X2 | Budget, seat prefs |
| **email** | No | gmail_* | Claude | Multi-step confirmation, high stakes |
| **recall** | Yes (primary data) | None | EVO X2 | Memory IS the answer |
| **planning** | Yes | All available | Claude | Complex reasoning |
| **conversational** | No | None | EVO X2 | Chat, banter |
| **general_knowledge** | No | web_search | Claude | Brave Search |

### Classification: Keyword-First, LLM-Fallback (Approach C)

**Layer 1 — Keyword heuristics** (instant, ~60-70% of messages):

| Pattern | Category |
|---------|----------|
| `/todo`, `remind me`, `add task`, `mark done` | task |
| `email`, `gmail`, `inbox`, `draft`, `send`, `reply` | email |
| `soul`/`personality` + `change`/`update`/`modify` | email (Claude-only path) |
| `calendar`, `diary`, `what's on`, `free time`, `schedule`, `book an event` | calendar |
| `train`, `flight`, `hotel`, `travel`, `fare`, `depart` | travel |
| `search for`, `google`, `look up`, `what is`, `who is`, `how does` | general_knowledge |

If multiple patterns match or no pattern matches, defer to Layer 2.

**Layer 2 — LLM classifier** (~1s on warm qwen3.5:35b):

```
Classify this WhatsApp message into exactly one category.
Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge
Reply with ONLY the category name, nothing else.

Message: "{user_message}"
```

### Routing Rules

Per-category routing controls three dimensions:

1. **Tool filtering** — EVO X2 only sees tools relevant to the classified category
2. **Memory injection** — only `travel`, `recall`, and `planning` trigger memory fetch
3. **Engine selection** — `email`, `planning`, `general_knowledge` always use Claude; rest try EVO X2 with Claude fallback

### System Prompts

- **EVO X2 categories** (calendar, task, travel, conversational, recall): Lean ~500 char prompt with date/time, formatting rules, anti-hallucination guardrails. Tool-specific formatting rules only for the tools in that category.
- **Claude categories** (email, planning, general_knowledge): Full system prompt, unchanged.
- **recall** specifically: Lean prompt + "Answer from the memories provided below. If no relevant memory exists, say so."

### Error Handling

- **EVO X2 failure** — fall through to Claude with full tools/memories (existing behaviour)
- **Classifier returns unexpected value** — default to `planning` (Claude + all tools + memories, safest fallback)
- **Keyword conflicts** (multiple patterns match) — defer to LLM classifier, no priority logic needed
- **Claude circuit breaker open + Claude-required category** — return "Claude unavailable" message

### Scope

**New files:**
- `src/router.js` — keyword heuristics, LLM classifier, routing rules, tool/memory/engine selection

**Modified files:**
- `src/claude.js` — `getClawdResponse` delegates to router instead of inline EVO-first logic
- `src/ollama.js` — accepts filtered tool sets and category-aware prompts

**Untouched:**
- Tool definitions, tool handler, tool implementations
- Dashboard, scheduler, WhatsApp layer
- Memory fetch/format logic (called conditionally, not changed)
- Claude prompt, token tracking, usage stats
