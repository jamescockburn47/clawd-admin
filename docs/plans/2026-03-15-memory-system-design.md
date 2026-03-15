# Clawd Life Assistant — Memory & Intelligence System

**Date:** 2026-03-15
**Status:** Planning — not yet approved for implementation
**Revision:** 2 (supersedes initial memory-only design)

## Vision

Clawd becomes a full life assistant with persistent memory, voice input, photo processing, and proactive intelligence. It actively builds a picture of James's life through every interaction channel, remembers what matters, and brings context forward when relevant — like a real PA who's been working with you for years.

## Infrastructure

```
┌──────────────────────────────────────────────────────────┐
│                    Pi 5 (Always On)                       │
│                    192.168.1.211                          │
│                                                           │
│  Clawdbot Service (Node.js)                              │
│  ├── WhatsApp I/O (Baileys)                              │
│  │   ├── Text messages → conversation log                │
│  │   ├── Voice notes → download .ogg → queue/forward     │
│  │   └── Photos → download → queue/forward               │
│  │                                                        │
│  ├── Dashboard (HTTP, port 3000)                         │
│  │   ├── Existing widgets (calendar, todos, weather...)  │
│  │   ├── Voice memo (browser MediaRecorder)              │
│  │   ├── Quick note text input                           │
│  │   ├── Memory viewer (search, browse, correct)         │
│  │   └── Admin panel (service status, health, logs)      │
│  │                                                        │
│  ├── Voice Activation (always listening)                 │
│  │   ├── openWakeWord → detects "Hey Clawd" (~1% CPU)   │
│  │   ├── VAD → records until silence                     │
│  │   └── Sends audio to EVO X2 for transcription         │
│  │                                                        │
│  ├── Memory Client                                       │
│  │   ├── Local cache (data/memory-cache.json)            │
│  │   ├── Keyword search (fallback when EVO X2 down)      │
│  │   └── Queue (data/memory-queue/)                      │
│  │       ├── audio/ (voice notes, memos)                 │
│  │       ├── images/ (WhatsApp photos)                   │
│  │       └── text/ (conversation logs, notes)            │
│  │                                                        │
│  ├── EVO X2 Health Monitor                               │
│  │   ├── Ping every 60s                                  │
│  │   ├── On reconnect: drain queue, sync cache           │
│  │   └── Status exposed to dashboard                     │
│  │                                                        │
│  └── Scheduler (existing 60s interval)                   │
│      ├── Todo reminders (existing)                       │
│      ├── Morning briefing (existing)                     │
│      ├── Proactive follow-ups (new)                      │
│      └── Memory queue flush trigger (new)                │
└──────────────────────────────────────────────────────────┘
              ▲                          │
              │  HTTP (port 5100)        │
              │  health / transcribe /   │
              │  analyse / extract /     │
              │  memory CRUD / maintain  │
              ▼                          │
┌──────────────────────────────────────────────────────────┐
│               EVO X2 (Usually On)                         │
│               192.168.1.230                               │
│               AMD Ryzen AI MAX+ 395                       │
│               128GB unified RAM, Radeon 8060S (ROCm)      │
│                                                           │
│  Memory Service (Python FastAPI — port 5100)             │
│  ├── /health              → alive + model status         │
│  ├── /transcribe          → Whisper large-v3 (audio→txt) │
│  ├── /analyse-image       → qwen3.5:35b vision          │
│  ├── /extract             → qwen3.5:35b fact extraction  │
│  ├── /embed               → nomic-embed-text             │
│  ├── /memory/store        → store fact + embedding       │
│  ├── /memory/search       → hybrid vector search         │
│  ├── /memory/list         → full dump (for Pi cache sync)│
│  ├── /memory/update       → correct/supersede a memory   │
│  ├── /memory/delete       → remove a memory              │
│  ├── /memory/stats        → counts, categories, queue    │
│  └── /maintain            → overnight consolidation      │
│                                                           │
│  Models (Ollama on port 11434)                           │
│  ├── qwen3.5:35b      24GB  (extraction, vision, maint) │
│  ├── nomic-embed-text  274MB (embeddings)                │
│  └── glm-4.7-flash    19GB  (fast extraction fallback)   │
│                                                           │
│  Whisper (whisper.cpp or faster-whisper)                  │
│  └── large-v3 model, ROCm GPU acceleration               │
│                                                           │
│  Data                                                    │
│  ├── memories.json (facts + 768-dim embeddings)          │
│  ├── memories_archive.json (expired/superseded)          │
│  └── processed/ (archived conversation logs)             │
│                                                           │
│  Overnight Jobs (cron)                                   │
│  ├── 02:00 — Process queued conversation logs            │
│  ├── 02:30 — Process queued audio transcriptions         │
│  ├── 03:00 — Consolidate/deduplicate memories            │
│  ├── 03:30 — Decay stale, flag contradictions            │
│  ├── 04:00 — Re-embed any memories with missing vectors  │
│  └── 04:30 — Sync memory cache to Pi                     │
└──────────────────────────────────────────────────────────┘
```

## Input Channels

| Channel | Source | Arrives at | Processing | Fallback (EVO X2 down) |
|---------|--------|-----------|------------|----------------------|
| WhatsApp text | James/MG via Baileys | Pi | Log → queue for batch extraction | Queue, process later |
| WhatsApp voice notes | James via Baileys | Pi (.ogg) | → EVO X2 Whisper → extract facts | Queue audio file |
| WhatsApp photos | James via Baileys | Pi (.jpg/.png) | → EVO X2 qwen3.5 vision → describe/OCR → extract | Fall back to Claude vision |
| Dashboard microphone | Pi hardware mic | Pi (.webm) | → EVO X2 Whisper → extract → respond | Queue audio file |
| Dashboard voice activation | openWakeWord on Pi | Pi (.wav) | → EVO X2 Whisper → interpret as command/note | Queue audio file |
| Dashboard text notes | Pi text input | Pi | Direct to memory store (minimal processing) | Store locally, sync later |
| Explicit "remember/note" | WhatsApp command | Pi | Direct to memory store | Store locally, sync later |
| Proactive follow-up responses | James replies to Clawd's questions | Pi | Normal conversation flow → extraction | Normal flow |

## Memory Data Model

```json
{
  "id": "mem_a7f3c9",
  "fact": "James prefers 07:15 KGX→YRK, avoids 06:30 (overcrowded, stood to Peterborough)",
  "category": "preference",
  "tags": ["travel", "train", "york", "lner", "kings-cross", "time"],
  "source": "whatsapp_conversation",
  "sourceDate": "2026-03-15",
  "confidence": 0.9,
  "supersedes": null,
  "lastAccessed": "2026-03-15",
  "accessCount": 0,
  "embedding": [0.023, -0.114, ...]
}
```

### Categories

| Category | Examples | Default TTL |
|----------|----------|-------------|
| `preference` | Train times, accommodation style, gift shops | Permanent |
| `person` | Contacts, relationships, who knows whom | Permanent |
| `legal` | Case deadlines, settlement figures, solicitor names | Permanent |
| `travel` | Specific fares, bookings, hotel prices | 14 days (prices stale) |
| `accommodation` | Places stayed, ratings, prices | 90 days |
| `henry` | School events, cricket, pickup logistics | 30 days |
| `ai_consultancy` | Recordum, contacts, leads, meetings | Permanent |
| `schedule` | One-off tasks, errands, pickups | 7 days |
| `general` | Miscellaneous useful facts | 90 days |

## Memory Extraction — Local Model on EVO X2

**Decision: All extraction runs on EVO X2 via qwen3.5:35b. Claude does NOT extract memories.**

Rationale:
- Claude has demonstrated hallucination in tool result reporting — trusting it to self-report memories is risky
- Local extraction with low temperature (0.1) and structured prompts is more controllable
- Cost: zero API spend for extraction
- Speed doesn't matter for background processing

### Extraction modes

**1. Batch overnight (primary)**
- Conversation logs from the day sent to EVO X2 at 02:00
- qwen3.5:35b with temp 0.1, thinking disabled
- Extracts facts, categories, tags, confidence scores
- De-duplicates against existing memories (vector similarity > 0.85 = duplicate)
- Embeds new facts via nomic-embed-text
- Archives processed logs

**2. On-demand (explicit commands)**
- "Remember: Sarah Chen, Clifford Chance, AI compliance" → immediate extraction
- "Note: parking at Clifton Park is a nightmare on Saturdays" → immediate
- These bypass batch queue — processed immediately on EVO X2 (or queued if down)

**3. Voice/photo processing**
- Audio → Whisper → transcript → extraction pipeline
- Photos → qwen3.5:35b vision → description → extraction pipeline
- Both produce text that feeds into the same extraction prompt

### Extraction prompt

```
You are a memory extraction system for a personal assistant serving James Cockburn,
a UK-based solicitor. Extract ALL key facts worth remembering from this conversation.

Rules:
- Output a JSON array of objects: {fact, category, tags, confidence}
- Facts must be concise (max 150 chars), specific, and actionable
- DO NOT extract greetings, filler, or conversational mechanics
- DO NOT extract information that duplicates calendar events or todos
- Attribute actions to the correct person (who did/wants/said what)
- Convert relative dates to absolute dates using today's date: {today}
- Confidence: 0.9+ for explicit statements, 0.7-0.9 for inferences, <0.7 for uncertain

Categories: preference, person, legal, travel, accommodation, henry, ai_consultancy, schedule, general

Output ONLY the JSON array.
```

### Tested accuracy (qwen3.5:35b, temp 0.1, think disabled)

| Test | Expected facts | Extracted | Correct | Accuracy | Time |
|------|---------------|-----------|---------|----------|------|
| Messy WhatsApp (settlement + accommodation) | 6 | 9 | 9/9 | 100% (more granular) | 19.3s |
| Implicit preferences (train times + errand) | 4 | 8 | 7/8 | 87.5% | 18.8s |

Known weakness: misattributing actions in complex sentences ("MG wants me to pick up Henry's cricket whites" → model confused who does what). Mitigated by confidence scores and manual correction.

## Memory Retrieval

### Hybrid scoring

```
score = 0.35 × keyword + 0.40 × vector + 0.15 × recency + 0.10 × frequency
```

- **Keyword (0.35):** Tokenise message, match against memory tags
- **Vector (0.40):** Cosine similarity between message embedding and memory embeddings
- **Recency (0.15):** `max(0, 1 - daysSinceCreated / 90)`
- **Frequency (0.10):** `min(1, accessCount / 10)`

### Two retrieval modes

**Passive (every incoming message):**
1. Fast keyword scan against memory tags
2. If any match scores > 0.3, embed the message via EVO X2
3. Run full hybrid search
4. Inject top 5-8 memories into Claude's system prompt
5. If no keyword hits, skip (saves latency for "thanks", "ok", etc.)

**Active (Claude tool call):**
- Claude calls `memory_search` with a natural language query
- Always runs full hybrid search
- Returns results to Claude for use in response

### Injection format (in system prompt)

```
## What you remember
- James prefers 07:15 KGX→YRK, avoids 06:30 (overcrowded) [preference, 15 Mar]
- Helmsley accommodation good, ~£85/night, Henry liked walking [accommodation, 12 Mar]
- Settlement with John: £350k (was £250k), deadline April 4th [legal, 15 Mar]
```

Token budget: max 8 memories × ~30 tokens = ~240 tokens. Negligible.

## Graceful Degradation (EVO X2 Offline)

| Feature | EVO X2 UP | EVO X2 DOWN |
|---------|-----------|-------------|
| Memory retrieval | Semantic vector search via API | Keyword search against local cache |
| Memory storage | Embed + store on EVO X2 | Queue locally, sync when back |
| Voice transcription | Whisper on EVO X2 | Queue audio, notify "will process later" |
| Photo analysis | qwen3.5:35b vision on EVO X2 | Fall back to Claude vision (costly) |
| Batch extraction | Runs overnight on EVO X2 | Skipped, retries next night |
| Dashboard memory viewer | Live from EVO X2 | Read from local cache (may be stale) |
| Everything else | Normal | Normal (no degradation) |

### Health check protocol

1. Pi pings `GET /health` on EVO X2 every 60 seconds
2. 3 consecutive failures = mark EVO X2 as offline
3. Switch to fallback mode for all EVO X2-dependent features
4. Continue pinging — on first success, mark online
5. On reconnect: drain queue (oldest first), sync memory cache
6. Dashboard shows EVO X2 status (green/red indicator)

### Local memory cache on Pi

- File: `data/memory-cache.json`
- Contains all memories WITHOUT embedding vectors (too large)
- Synced from EVO X2 after every queue drain and at 04:30 daily
- Keyword-searchable using tag matching
- Stale indicator: if cache is >24h old, show warning on dashboard

## Voice Activation (Pi Microphone)

### Architecture

```
Microphone → openWakeWord (always listening, ~1% CPU)
                 │
                 ├── Wake word detected ("Hey Clawd")
                 │       │
                 │       ▼
                 │   Start recording
                 │       │
                 │       ▼
                 │   VAD (voice activity detection)
                 │       │
                 │       ├── Silence detected → stop recording
                 │       │       │
                 │       │       ▼
                 │       │   Send .wav to EVO X2 /transcribe
                 │       │       │
                 │       │       ▼
                 │       │   Interpret: command? note? question?
                 │       │       │
                 │       │       ├── Command → execute via Clawd
                 │       │       ├── Note → store in memory
                 │       │       └── Question → route to Claude
                 │       │
                 │       └── Timeout (30s) → stop recording, discard
                 │
                 └── No wake word → continue listening
```

### Components

| Component | Implementation | Resource usage |
|-----------|---------------|----------------|
| Wake word detection | openWakeWord (Python) | ~1% CPU, ~50MB RAM |
| Audio capture | PyAudio / sounddevice | Minimal |
| VAD | Silero VAD or WebRTC VAD | ~1% CPU |
| Audio format | 16kHz mono WAV | ~32KB/sec |
| Wake word | Custom "Hey Clawd" (trainable) | One-time training |

### Dashboard voice memo (separate from wake word)

- Press-to-record button on dashboard
- Browser MediaRecorder API captures from Pi microphone
- Uploads .webm to clawdbot HTTP endpoint
- Same processing pipeline as wake word recordings
- Shows transcription result on dashboard for verification

## Photo Processing

### Current flow (expensive)
```
WhatsApp photo → download on Pi → base64 → Claude vision API (~1000+ tokens input)
```

### New flow (free when EVO X2 up)
```
WhatsApp photo → download on Pi → POST to EVO X2 /analyse-image
    → qwen3.5:35b vision describes image
    → extract any facts for memory
    → respond via WhatsApp with description
    → if EVO X2 down: fall back to Claude vision
```

## Proactive Feedback Loop

A real PA follows up. Rules to avoid being annoying:

| Trigger | Timing | Action | Limit |
|---------|--------|--------|-------|
| Calendar meeting ends | 2 hours after end time | "How did the meeting with X go? Anything to note?" | Once per event |
| Henry weekend approaching | 3 days before | "Henry weekend on [date]. Last time you stayed at [place]. Want me to look again?" | Once per weekend |
| Stale task detected | Evening check | "You mentioned calling John before Thursday — did that happen?" | Once per task |
| New memories from overnight | Morning briefing | Include "I noted X new things yesterday" in briefing | Daily |
| Weekly review | Sunday 8pm | "Here's what I noted this week" with correction option | Weekly |

### Correction flow

**Via WhatsApp:** "That's wrong — I play cricket at Clifton Park, not Henry"
- Clawd has a `memory_update` tool
- Searches for the incorrect memory
- Updates it with corrected information
- Confirms the change

**Via dashboard:** Memory viewer widget
- Searchable list of all memories
- Each memory: edit button, delete button
- Inline editing of fact text, category, tags
- Changes sync to EVO X2 immediately (or queue if down)

## Admin Panel (Dashboard)

New section on the dashboard showing system health:

### Service Status Widget

```
┌─────────────────────────────────────────┐
│  SYSTEM STATUS                          │
│                                         │
│  Pi (clawdbot)     ● Online   3d 14h    │
│  EVO X2            ● Online   1d 2h     │
│  Ollama            ● Running  qwen3.5   │
│  Whisper           ● Ready              │
│  Wake Word         ● Listening          │
│                                         │
│  MEMORY                                 │
│  Total memories:   247                  │
│  Categories:       pref(42) person(38)  │
│                    legal(15) travel(89) │
│                    henry(31) other(32)  │
│  Last extraction:  02:00 today          │
│  Queue depth:      0 pending            │
│  Cache age:        4h (fresh)           │
│                                         │
│  PROCESSING                             │
│  Voice notes today:    3                │
│  Photos today:         1                │
│  Extractions today:    12               │
│  API calls saved:      ~$0.45           │
└─────────────────────────────────────────┘
```

### Memory Browser Widget

```
┌─────────────────────────────────────────┐
│  MEMORY  [search________________] [🔍]  │
│                                         │
│  ● James prefers 07:15 KGX→YRK    [✎✕] │
│    preference | 15 Mar | conf: 0.9      │
│                                         │
│  ● Settlement: £350k, deadline Apr 4    │
│    legal | 15 Mar | conf: 0.95     [✎✕] │
│                                         │
│  ● Helmsley ~£85/night, good walks      │
│    accommodation | 12 Mar | conf: 0.9[✎✕]│
│                                         │
│  [< prev]  page 1 of 12  [next >]      │
└─────────────────────────────────────────┘
```

### Quick Note Widget

```
┌─────────────────────────────────────────┐
│  QUICK NOTE                             │
│  [type a note or memo...            ]   │
│  [Save Note]     [🎤 Record Memo]       │
└─────────────────────────────────────────┘
```

## EVO X2 Memory Service — Technology Choice

**Python (FastAPI)** rather than Node.js:
- Better ecosystem for Whisper (faster-whisper, whisper.cpp bindings)
- Better ML tooling (numpy for cosine similarity, etc.)
- FastAPI is fast, async, auto-generates OpenAPI docs
- The REST API makes the language irrelevant to the Pi (JSON over HTTP)
- Systemd service, auto-starts on boot

## Testing Regiment

### Unit Tests

| Test | Description | Pass criteria |
|------|-------------|---------------|
| Memory store | Store a fact, verify JSON file updated | Record exists with correct fields |
| Memory search (keyword) | Store 10 facts, search by keyword | Correct results ranked by relevance |
| Memory search (vector) | Store 10 facts, search semantically | Related facts returned even without keyword match |
| Memory search (hybrid) | Combined scoring | Hybrid beats keyword-only and vector-only |
| Memory update | Modify a fact | Old fact superseded, new fact stored |
| Memory delete | Remove a fact | Fact removed from active, moved to archive |
| Memory expiry | Store fact with TTL | Fact expires after TTL |
| Embedding generation | Embed text | 768-dim vector returned |
| Transcription | Send audio | Correct text returned |
| Image analysis | Send photo | Meaningful description returned |
| Extraction (simple) | Simple conversation | All facts extracted correctly |
| Extraction (complex) | Ambiguous conversation | Facts extracted with appropriate confidence |
| Deduplication | Store similar facts | Duplicates detected and merged |
| Supersession | Update contradicting fact | Old fact superseded by new |

### Integration Tests

| Test | Description | Pass criteria |
|------|-------------|---------------|
| Pi → EVO X2 store + retrieve | Store from Pi, search from Pi | Round-trip works |
| Queue drain | Queue items while EVO X2 down, bring back up | All queued items processed |
| Cache sync | Store on EVO X2, sync to Pi | Pi cache matches EVO X2 |
| Fallback search | Search with EVO X2 down | Keyword search returns results from cache |
| Photo fallback | Send photo with EVO X2 down | Claude vision used instead |
| Voice → memory | Record voice, transcribe, extract, store | Fact appears in memory |
| WhatsApp → memory | Send message, overnight extraction | Fact appears next morning |
| Memory injection | Message triggers memory, Claude receives context | Claude's response uses memory |
| Correction via WhatsApp | "That's wrong, X" | Memory updated |
| Dashboard CRUD | Add/edit/delete via dashboard | Changes reflected in EVO X2 store |

### Accuracy Tests

| Test | Method | Target |
|------|--------|--------|
| Extraction accuracy | 20 real WhatsApp conversations, manual scoring | >85% facts extracted correctly |
| Attribution accuracy | 10 messages with multiple people mentioned | >90% correct attribution |
| Retrieval relevance | 20 queries against 100+ memories | >80% top-5 contains correct memory |
| Whisper accuracy | 10 voice notes with varying quality | >95% word accuracy |
| Vision accuracy | 10 photos (documents, receipts, scenes) | Meaningful description for all |

### Load/Stress Tests

| Test | Method | Target |
|------|--------|--------|
| Retrieval latency (EVO X2 up) | 100 searches, measure p50/p95 | p50 < 200ms, p95 < 500ms |
| Retrieval latency (fallback) | 100 keyword searches on Pi | p50 < 50ms |
| Batch extraction | Process 100 conversations | Complete within 30 minutes |
| Memory scale | 5000 memories, search | < 500ms including embedding |
| Queue drain | 50 queued items | Process all within 10 minutes |

### End-to-End Scenarios

1. **Morning workflow:** James says "Hey Clawd" → asks about trains to York → system retrieves preference for 07:15 → Claude mentions it proactively
2. **Photo receipt:** James sends photo of restaurant receipt → EVO X2 analyses → extracts restaurant name, cost, date → stores in memory
3. **Voice note from car:** James records memo about meeting → transcribed → facts extracted → available next time he asks about that meeting
4. **Correction loop:** Clawd follows up about meeting → James corrects a detail → memory updated → future queries reflect correction
5. **Offline resilience:** EVO X2 goes down → James continues using Clawd normally → EVO X2 comes back → queue drains → memories available

## Implementation Phases

### Phase 1: EVO X2 Memory Service
- FastAPI service with all endpoints
- Whisper integration (faster-whisper or whisper.cpp)
- qwen3.5:35b integration via Ollama API
- nomic-embed-text for embeddings
- Memory JSON store with cosine similarity search
- Hybrid retrieval (keyword + vector + recency + frequency)
- Systemd service, auto-start on boot
- Full test suite

### Phase 2: Pi Integration
- Memory client module in clawdbot
- EVO X2 health monitor (60s ping)
- Memory queue system (audio, images, text)
- Queue drain on reconnect
- Local memory cache with keyword fallback
- `memory_search` tool for Claude
- Passive memory injection into system prompt
- Photo routing (EVO X2 → Claude fallback)
- Voice note routing

### Phase 3: Voice Activation
- openWakeWord setup on Pi (custom "Hey Clawd")
- Microphone audio capture service
- VAD for recording boundaries
- Dashboard voice memo button
- Dashboard quick note input

### Phase 4: Dashboard Admin & Memory UI
- Service status widget (Pi, EVO X2, Ollama, Whisper, wake word)
- Memory browser widget (search, browse, paginate)
- Memory edit/delete from dashboard
- Quick note widget
- Queue status display

### Phase 5: Proactive Intelligence
- Post-meeting follow-up scheduler
- Henry weekend pre-planning prompts
- Stale task detection
- Morning briefing memory integration
- Weekly memory review (Sunday digest)
- Memory correction via WhatsApp ("that's wrong")

### Phase 6: Overnight Batch Processing
- Conversation log archival from Pi → EVO X2
- Batch extraction job (qwen3.5:35b, temp 0.1)
- Deduplication and consolidation
- Supersession detection
- Expiry and archival
- Nightly cache sync to Pi

## Model Benchmarks (Measured 2026-03-15)

### Fact Extraction (thinking disabled, temp 0.1)

| Model | Time | Tokens | Quality notes |
|-------|------|--------|---------------|
| glm-4.7-flash | 1.8-11.6s | 89-201 | Fast, good quality, occasional missed details |
| qwen3.5:35b | 13.4-19.3s | 62-333 | More granular, captures more facts, better structure |
| qwen3:32b | 15.2s | 81 | Good but slower than GLM for same quality |

**Decision:** qwen3.5:35b for overnight batch (accuracy matters, speed doesn't). glm-4.7-flash available as fast fallback if needed.

### Known extraction weaknesses

- Both models struggle with attributing actions in complex multi-person sentences
- "MG wants me to pick up Henry's cricket whites" → misattributed by both models
- Mitigation: confidence scores, overnight cross-referencing, manual correction

## Key Design Decisions

1. **All extraction on EVO X2 (local), not Claude** — Claude hallucinated calendar events. Local model with low temp + structured prompt is more controllable and free.
2. **qwen3.5:35b as primary extraction model** — multimodal (handles photos too), better accuracy than GLM for complex scenarios, speed irrelevant for background work.
3. **Python (FastAPI) for EVO X2 service** — better Whisper/ML ecosystem than Node.js.
4. **JSON over vector DB** — at PA scale (<10k memories), brute-force cosine is <5ms. No premature optimisation.
5. **Offline-first design** — Pi works without EVO X2. Queue, cache, fallback. Never break the primary WhatsApp bot.
6. **openWakeWord for voice activation** — lightweight, custom wake word, runs on Pi without Whisper.
7. **Proactive but not annoying** — one follow-up per trigger, configurable, always skippable.
8. **Dashboard as control plane** — memory viewer, service status, quick notes. James sees and controls what Clawd knows.

## Cost Impact

| Feature | Current cost | With memory system |
|---------|-------------|-------------------|
| Photo analysis | ~$0.01-0.03 per photo (Claude vision) | $0 (EVO X2 local, Claude fallback only) |
| Memory extraction | N/A | $0 (all local) |
| Voice transcription | N/A | $0 (Whisper local) |
| Morning briefing | ~$0.05/day (Claude) | $0.05/day (still Claude, could migrate later) |
| Memory injection | N/A | ~$0.001/message (extra ~240 tokens in prompt) |

Estimated monthly saving: ~$5-15 on photo/vision costs depending on usage.
