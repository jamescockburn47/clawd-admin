# Data Flows

## WhatsApp Message → Response

1. Baileys receives message via WebSocket
2. `trigger.js` decides: direct (prefix/mention/reply), passive (name in text → classifier), random (probability), or ignore
3. If image: download via `downloadMediaMessage()`, base64 → EVO VL (Claude fallback). Follow-ups within 5 min reuse last image per chat
4. If document (PDF/DOCX): parse on Pi (pdf-parse/mammoth) → summarise via EVO 30B → Claude receives summary (85% token reduction). Raw text cached
5. `buffer.js` builds conversation context (last 10 messages, includes `[Current message]` section)
6. `router.js` classifies activity category (keywords first → EVO classifier on 8081 → fallback)
7. If EVO available and not forced to Claude: `evo-llm.js` sends to Qwen3-30B via OpenAI-compatible API with category-scoped tools
8. If EVO unavailable, empty response, or must-use-Claude: `claude.js` sends to Claude API with full prompt + tools
9. Tool execution loop (up to 5 iterations) — `handler.js` dispatches, `audit.js` logs
10. Final text response sent via Baileys
11. `interaction-log.js` records request/response with routing metadata
12. SSE broadcasts message to dashboard
13. Circuit breakers protect against cascading API failures

## Message Routing Architecture

```
Message → Keywords → EVO classifier (port 8081) → Fallback
              │              │                        │
              ▼              ▼                        ▼
        Category match  Category match          Default: Claude
        (fast, free)    (Qwen3-0.6B, ~50ms)
              │              │
              ▼              ▼
        ┌─────────────────────────────┐
        │ Category → Tool set scoping │
        │ calendar, task, travel,     │
        │ email, recall, planning,    │
        │ conversational, general,    │
        │ system                      │
        └──────────────┬──────────────┘
                       │
              ┌────────┴────────┐
              ▼                 ▼
        EVO X2 (8080)      Claude API
        Category-scoped    Full tool access
        tools              (fallback or forced)
```

Router telemetry logged to `data/router-stats.jsonl`. Self-improvement cycle (`self-improve/cycle.js`) probes for missed keyword rules overnight.

## Response Pipeline — Model Allocation

| Model | Location | Port | Role |
|-------|----------|------|------|
| **MiniMax M2.7** | Cloud API | — | Default for chat, tools, email, planning, evolution, quality gate |
| **Claude Opus 4.6** | Cloud API | — | Premium — explicit request only, or MiniMax fallback |
| **Qwen3-0.6B** | EVO X2 | 8081 | Engagement gating + message classification |
| **Qwen3-VL-30B-A3B** | EVO X2 | 8080 | Vision/image understanding, document summarisation |
| **Memory Service** | EVO X2 | 5100 | Dream storage, memory search, context injection |
| **SearXNG** | EVO X2 | 8888 | Self-hosted web search |

### Key Rules

- **EVO VL 30B generates real user-facing responses** — not just classification
- **Claude handles all writes** — email, calendar mutation, soul changes
- **Images → EVO VL first** — Claude is fallback only
- **Documents summarised via EVO** before Claude — 85% token reduction
- **Web search uses SearXNG** on EVO — free, self-hosted
- **EVO offline → everything falls back to Claude** — more expensive but never broken

## Dashboard Data Flow

1. `widgets.js` fetches from Google Calendar + Gmail + Open-Meteo every 5 minutes
2. Results cached in memory (`widgetCache`, 5-min TTL), circuit breakers return stale cache on failure
3. Dashboard loads via HTTP GET `/api/widgets`, `/api/todos`, `/api/soul`
4. Real-time updates via SSE (`/api/events`) for widgets, todos, soul, messages
5. Dashboard shows: weather in header, usage alerts (amber/red), 3-state status dot
6. Dashboard chat input → POST `/api/chat` → Claude → response

## Scheduler (Proactive Notifications)

Runs every 60 seconds (lightweight in-process check):

1. **Todo reminders** — finds items with past reminder times, sends WhatsApp, marks reminded
2. **Side gig meeting alerts** — reads widget cache (no API call), 25-35 min warning
3. **Morning briefing** at 07:00 London — weather + calendar + todos + Henry status + overnight insights
4. **Self-improvement cycle** at 01:00 — probes classifier, proposes rules, validates against eval suite
5. **Overnight extraction** at 02:00 — extracts facts from yesterday's logs into EVO memory
6. **System knowledge refresh** at 02:00 — regenerates self-knowledge in EVO memory
7. **Daily backup** at 03:00 — todos, soul, soul_history (7-day retention)
8. **Project Deep Think** at 23:00 — multi-model strategic analysis on active projects
9. **Weekly memory review** Sundays 20:00 — memory stats summary
10. **Widget cache refresh** every 5 min
11. **EVO model warm-keeping** every 10 min
12. **Memory cache sync** every 30 min

Zero token cost for routine checks — no Claude API calls.

## Voice Command Flow (EVO X2 → Pi)

1. Fifine USB mic captures audio at 44.1kHz via PyAudio
2. Resample to 16kHz, gain applied (configurable, default 6.0x)
3. RMS speech detection (threshold 3000 after gain)
4. Records until 1.2s silence or 12s max
5. Trims silence → faster-whisper (distil-small.en, CPU, int8)
6. Rejects Whisper hallucinations ("thank you", single short words, etc.)
7. Checks first 45 chars for wake phrase (clawd/claude/claud/clawed/klawd/cloud/claw)
8. Strips wake phrase, classifies command via classifier (port 8081)
9. Routes locally (EVO tools via Qwen3-30B) or to Pi `/api/voice-command` for Claude
10. Response → Piper TTS → spoken output
11. Dashboard voice overlay: Listening → Processing → Response → auto-dismiss

**Tuning** (env vars, defaults in voice_listener.py): `MIC_GAIN=6.0`, `SPEECH_THRESHOLD=3000`, `SILENCE_DURATION=1.2`, `WHISPER_MODEL=distil-small.en`

## Evolution Pipeline (Self-Coding)

```
Trigger (WhatsApp or dream mode)
    → Task queued in data/evolution-tasks.json
    → Scheduler picks up (max 3/day, 1/hour, 1 concurrent)
    → Pi SSHes to EVO, syncs codebase, creates git branch
    → Pass 1: Claude Code outputs JSON manifest (files, lines, approach)
    → Manifest rejected if >5 files or >150 lines
    → Pass 2: executes within approved scope only
    → PreToolUse hook enforces scope (evo-hooks/scope-guard.sh)
    → Git diff captured, sent to James via WhatsApp DM
    → "approve" → merge + rsync to Pi + restart + health check
    → "reject" → branch deleted, logged
    → Health check failure → auto-revert commit, re-rsync, restart
```

Safety: Owner-only, git branches (never main), DM approval, auto-rollback, scope guards, banned files list.
