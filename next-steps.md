# Next Steps — Clawdbot Session 2026-03-23

## What Was Built Today

### Completed and deployed:
1. **SearXNG** — free self-hosted web search on EVO (Docker, port 8888). Replaced Brave Search (no API key needed). `web_search` tool rewritten.
2. **Qwen3-VL-30B-A3B** — replaced main EVO server with vision-language model. Same text perf, adds image understanding. 32K context. Port 8080.
3. **Granite-Docling-258M F16** — dedicated document parsing model on EVO port 8084. Renders PDF pages via pdftoppm, sends to Docling for structured markdown extraction.
4. **Document pipeline** — PDF/DOCX parsed on Pi, summarised via EVO (71% token reduction), summary sent to Claude. Raw text cached for follow-ups. Documents stored permanently in vector DB (summary + chunks + index).
5. **LQuorum working memory** — keyword-triggered topic recall from 18 legal AI community topics. `scanMessage()` for passive group monitoring, `warmFromQuery()` for direct queries. Topics decay after 15-30 min.
6. **Image routing** — images go to EVO VL model first, Claude as fallback. No tools for vision queries. 5-min follow-up cache per chat.
7. **Classifier silence** — `[SILENT]` marker system. Mentioned-but-not-addressed produces silence, not "this message isn't for me."
8. **Professional group filtering** — personal categories (travel, task, email) and personal memories blocked in professional groups.
9. **System knowledge wipe-and-reseed** — every restart deletes old entries and re-seeds fresh from system-knowledge.json. No more stale duplicates competing.
10. **max_tokens 4x** — substantive responses get 4000 tokens (was 2000). Stops truncation on long analyses.
11. **Google OAuth dead flag** — stops invalid_grant retry spam every 60 seconds.

### Infrastructure on EVO (all running 24/7):
| Service | Port | Model | Purpose |
|---------|------|-------|---------|
| llama-server-main | 8080 | Qwen3-VL-30B-A3B Q4_K_M | Text + vision, 32K ctx |
| llama-server-classifier | 8081 | Qwen3-0.6B Q8_0 | Engagement + routing |
| llama-server-embed | 8083 | nomic-embed-text-v1.5 Q8_0 | Embeddings (always on) |
| llama-server-docling | 8084 | Granite-Docling-258M F16 | Structured doc parsing |
| clawdbot-memory | 5100 | — | FastAPI memory service |
| SearXNG | 8888 | — | Docker, web search |

## What Still Needs Building

### Priority 1: Diary insights system (combination of morning briefing + topic-tagged retrieval)

**Morning briefing insights:**
- The scheduler already sends a morning WhatsApp briefing (weather, calendar, todos, Henry)
- Add an "overnight insights" section that includes non-trivial diary insights from last night
- Diary already runs at 22:05 and produces diary entries. Need to extract insights separately
- Cost: one extra section in an existing message per day

**Topic-tagged insight retrieval:**
- When diary extracts an insight (a connection, a cross-reference, a question raised), tag it as `category: 'insight'` with topic tags
- Insights surface through memory search when conversation topic overlaps with insight tags
- Similar infrastructure to lquorum working memory — topic-triggered, not always-on
- Need: insight extraction in dream_mode.py, new category in memory service, topic tags

### Priority 2: Document memory improvements

**Dream reflection on documents:**
- Document log (`data/document-log.json`) already captures docs shared during the day
- Dream mode prompt already includes a DOCUMENTS I REVIEWED section
- Need to verify tonight's 22:05 run actually produces document reflections
- Check: does the diary extract cross-document insights? Does it connect documents to conversations?

**Retrieval of stored documents:**
- Documents are stored as chunks in vector DB with `category: 'document_chunk'`
- Follow-up questions after 5 min should retrieve chunks via vector search
- Need to test: "what did that ecosystem analysis say about compliance tools?" — does it find the right chunks?

### Priority 3: Accuracy and behaviour

**Web search enforcement:**
- Knowledge rule says "MUST search before factual responses" but Claude still answers from training data sometimes
- The prompt instruction exists but isn't strong enough
- Consider: making web_search a forced first tool call for `general_knowledge` category

**Clawd honesty about own processing:**
- Clawd told Jamie "not exactly — you wouldn't summarise just to save cost" when it literally did summarise
- The document context label says "summarised locally" but Claude interprets it loosely
- Fix: make the label unambiguous — "This document was summarised by my local model before I received it. The full text is stored in my memory for detailed follow-up."

**Soul alignment with real architecture:**
- Soul personality section still says "mention-only mode" — doesn't match classifier reality
- Soul should describe real behaviour: "engagement classifier decides, I read the room, I don't jump in unless adding something real"
- Low priority since the hardcoded prompt overrides soul anyway

### Priority 4: Google OAuth

- All Google services (calendar, email, Henry weekends, side gig) returning `invalid_grant`
- Refresh token needs regenerating
- `googleAuthDead` flag suppresses retry spam but all Google features are offline
- James needs to re-authenticate at https://accounts.google.com/o/oauth2/v2/auth with the existing client ID

### Priority 5: Miscellaneous

- **pdf-parse v2 API change** — exports `PDFParse` class, not function. Document handler uses Granite-Docling as primary parser now, but pdf-parse fallback needs fixing for non-image PDFs
- **Version bump** — version.json should be bumped to reflect today's changes
- **CLAUDE.md updates** — EVO main model is now Qwen3-VL-30B-A3B, SearXNG replaces Brave, Docling on port 8084, document handling described. Partially updated — review for completeness
- **Dashboard Rust source** — some changes in clawd-dashboard/src/ were staged but the dashboard binary on Pi may need rebuilding

## Architecture After Today's Session

```
WhatsApp message arrives
    |
    +-- Document? --> Parse on Pi (mammoth/Docling) --> Summarise via EVO --> Cache raw + store chunks in vector DB
    +-- Image? --> EVO VL model (port 8080) --> Claude fallback
    +-- Text? --> Normal routing
    |
    Engagement gate (groups only)
    |   +-- Mute active? --> silent
    |   +-- Classifier (EVO 0.6B) --> YES/NO
    |   +-- has_relevant_knowledge from working memory --> nudges YES
    |   +-- [SILENT] marker if mentioned but nothing to add
    |
    Router (complexity --> keywords --> LLM --> fallback)
    |   +-- forceClaude for writes, complex, long messages
    |   +-- Local EVO for reads, simple, conversational
    |
    Context assembly
    |   +-- Memory search (8 results, filtered for professional groups)
    |   +-- LQuorum working memory (topic-matched, pre-staged)
    |   +-- Document summary (if doc attached)
    |   +-- Self-awareness (always injected)
    |
    Response generation
    |   +-- EVO 30B or Claude depending on route
    |   +-- Tool loop (up to 5 iterations)
    |   +-- Web search forced for factual queries
    |
    Output
        +-- [SILENT] filtered out
        +-- Split at 3000 chars for WhatsApp
        +-- Follow-up mode (reuse image/doc cache for 5 min)

Overnight (22:05):
    Dream mode --> Experience diary --> Fact extraction --> Document reflection
    --> Stored as diary + general memories
    --> Morning briefing includes insights (TODO)
```

## Key Files Changed

- `src/lquorum-rag.js` — NEW: working memory module
- `src/claude.js` — image routing, warmFromQuery, max_tokens, document handling
- `src/evo-llm.js` — vision support, document summarisation, warmFromQuery
- `src/index.js` — document download/parse, [SILENT] filter, image caching
- `src/prompt.js` — silence rules, professional group filtering, knowledge rules, no emojis
- `src/tools/search.js` — SearXNG integration
- `src/tools/definitions.js` — web_search tool definition updated
- `src/system-knowledge.js` — wipe-and-reseed, subsystem entries
- `src/engagement.js` — has_relevant_knowledge signal
- `src/router.js` — image routing, forceClaude logic
- `src/memory.js` — document storage (summary + chunks + index)
- `src/scheduler.js` — OAuth dead flag, version-only startup message
- `data/system-knowledge.json` — comprehensive self-knowledge
- `data/lquorum-knowledge.json` — 18 topics, structured community knowledge
- `evo-voice/dream_mode.py` — diary structure, document reflection, fact extraction
- `memory-service/main.py` — document categories, chunk storage
