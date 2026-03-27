# API & Infrastructure Reference

## HTTP Endpoints

All endpoints on Pi port 3000. Auth via `DASHBOARD_TOKEN` as Bearer token or query param.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/dashboard` | Token (query) | Serves dashboard HTML |
| GET | `/api/status` | Bearer | Connection status, uptime, memory, lastActivity |
| GET | `/api/widgets` | Bearer | Cached widget data (incl. weather) |
| POST | `/api/widgets/refresh` | Bearer | Force widget refresh |
| GET | `/api/events` | Token (query) | SSE event stream |
| POST | `/api/chat` | Bearer | Send message to Clawd |
| GET | `/api/usage` | Bearer | Token usage + cost stats |
| GET | `/api/soul` | Bearer | Soul data + pending + history |
| POST | `/api/soul/reset` | Bearer | Reset all soul sections |
| GET | `/api/todos` | Bearer | All todo items |
| POST | `/api/todos/complete` | Bearer | Complete a todo by ID |
| GET | `/api/messages` | Bearer | Recent owner DM messages |
| GET | `/api/audit` | Bearer | Last 50 tool execution audit entries |
| GET | `/api/quality` | Bearer | Interaction quality summary (evolution) |
| GET | `/api/evo` | Bearer | EVO X2 llama-server health check |
| GET | `/api/memory/status` | Bearer | EVO X2 + memory service stats |
| GET | `/api/memory/list` | Bearer | All stored memories |
| POST | `/api/memory/search` | Bearer | Search memories by query |
| POST | `/api/memory/note` | Bearer | Store a quick note |
| PUT | `/api/memory/:id` | Bearer | Update a memory by ID |
| DELETE | `/api/memory/:id` | Bearer | Delete a memory by ID |
| POST | `/api/voice-command` | Bearer | Voice command from EVO (text + source) |
| POST | `/api/voice-status` | Bearer | Voice status events from EVO |
| POST | `/api/voice-local` | Bearer | Locally-routed voice command (action + params) |
| POST | `/api/desktop-mode` | None | Kill kiosk Chromium to expose Pi desktop |
| POST | `/api/send` | None | Proactive message send (jid + message) |
| POST | `/api/evolution/task` | Token | Create evolution coding task |
| GET | `/api/system-health` | Bearer | Consolidated subsystem statuses |

## Tool Access Control

`OWNER_ONLY_TOOLS` in `claude.js` restricts tools to James only:

| Tool | Restricted? | Notes |
|------|------------|-------|
| `gmail_*` | Yes | Email is private |
| `soul_propose/confirm` | Yes | Personality changes owner-only |
| `calendar_create/update` | Yes | Calendar mutations owner-only |
| `calendar_list/find_free_time` | No | Reading safe for all |
| `todo_*` | No | MG can add/complete todos |
| `train_*`, `hotel_search` | No | Travel tools open to all |
| `web_search`, `web_fetch` | No | Search open to all |
| `evolution_task` | Yes | Self-coding owner-only, triple-gated |

## Infrastructure Components

| Component | File | Purpose |
|-----------|------|---------|
| Pino Logger | `src/logger.js` | Structured logging |
| EVO LLM Client | `src/evo-llm.js` | llama.cpp OpenAI-compatible API + tool calling |
| EVO Client | `src/evo-client.js` | Shared HTTP client for all EVO communication |
| Router | `src/router.js` | Activity classification (keywords → classifier → fallback) |
| Router Telemetry | `src/router-telemetry.js` | Routing decision stats (JSONL) |
| Interaction Log | `src/interaction-log.js` | Conversation-level logging + feedback |
| System Knowledge | `src/system-knowledge.js` | Seeds architecture docs into EVO memory |
| Self-Improve Cycle | `src/self-improve/cycle.js` | Overnight router keyword rule improvement |
| Evolution Store | `src/evolution.js` | Task queue, approval flow, rate limiting |
| Evolution Executor | `src/evolution-executor.js` | Claude Code CLI on EVO, git branches, deploy + rollback |
| Evolution Gate | `src/evolution-gate.js` | Scope validation, manifest checking |
| Memory Client | `src/memory.js` | EVO memory service (store/search/list/delete) |
| LQuorum Working Memory | `src/lquorum-rag.js` | Passive keyword scanning, topic warming, decay |
| Weather | `src/weather.js` | Open-Meteo forecasts (free) |
| Audit Log | `src/audit.js` | Append-only tool execution log (1000 cap) |
| Circuit Breaker | `src/circuit-breaker.js` | Protects Google/Claude/Weather/MiniMax API calls |
| Buffer | `src/buffer.js` | Rolling context + persistent owner DM buffer |
| Message Handler | `src/message-handler.js` | WhatsApp message processing |
| Message Cache | `src/message-cache.js` | Message deduplication (last 200 IDs) |
| Conversation Logger | `src/conversation-logger.js` | JSONL logging for all group messages |
| Document Handler | `src/document-handler.js` | PDF/DOCX parsing + EVO summarisation |
| HTTP Server | `src/http-server.js` | Express server setup |
| SSE | `src/sse.js` | Server-sent events for dashboard |
| Usage Tracker | `src/usage-tracker.js` | Token cost tracking |
| Quality Gate | `src/quality-gate.js` | Opus review of complex responses |
| Session Repair | `src/session-repair.js` | WhatsApp session recovery |
| Constants | `src/constants.js` | Fixed values (timeouts, buffer sizes, cooldowns) |
| Config | `src/config.js` | Env-var-driven configuration |

## Dashboard Layout

3-column layout on 1024x600 Pi touchscreen:

```
┌──────────────┬──────────────┬──────────────┐
│ LEFT         │ CENTER       │ RIGHT        │
│ (swipeable)  │ (static)     │ (swipeable)  │
│              │              │              │
│ Page 0:      │ Todos &      │ Page 0:      │
│ Henry        │ Reminders    │ Admin +      │
│ Weekends     │              │ System Health│
│              │ - Active     │              │
│ Page 1:      │   (tap done) │ Page 1:      │
│ Calendar     │ - Completed  │ Email        │
│ (14 days)    │              │              │
│              │              │ Page 2:      │
│              │              │ Soul Config  │
└──────────────┴──────────────┴──────────────┘
```

- Left: 42%, Center: 30%, Right: 28% of 1024px
- Touch targets 48px+ for Pi touchscreen
- Native Rust/egui app (NOT browser)
- Voice overlay: compact bottom-anchored cards
- Bottom bar: last message + chat input + voice
