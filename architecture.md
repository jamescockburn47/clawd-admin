# Architecture — Clawdbot

> See also: [Data Flows](docs/data-flows.md) | [API Reference](docs/api-reference.md) | [Deployment](docs/deployment.md) | [EVO X2 Reference](docs/evo-x2-reference.md)

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Raspberry Pi 5 (8GB, 10.1" touchscreen, 1024x600)                 │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  systemd: clawdbot.service                           │           │
│  │  node --env-file=.env src/index.js                   │           │
│  │                                                      │           │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │           │
│  │  │ Baileys   │  │ Claude   │  │ HTTP Server (:3000)│ │           │
│  │  │ WhatsApp  │  │ API      │  │ - REST API         │ │           │
│  │  │ WebSocket │  │ Client   │  │ - SSE events       │ │           │
│  │  └─────┬─────┘  └────┬─────┘  └────────┬───────────┘ │           │
│  │        │              │                 │             │           │
│  │        ▼              │                 │             │           │
│  │  ┌──────────┐  ┌─────┴──────┐  ┌───────┴──────────┐ │           │
│  │  │ Trigger   │  │ Tool       │  │ Widget Cache     │ │           │
│  │  │ Engine    │  │ Dispatcher │  │ (5 min TTL)      │ │           │
│  │  └──────────┘  │ + Audit    │  │ + Weather        │ │           │
│  │                 └─────┬──────┘  └──────────────────┘ │           │
│  │  ┌──────────┐        │                               │           │
│  │  │ Router   │  ┌─────┴──────────────────────────┐   │           │
│  │  │ (smart   │  │ Tools:                         │   │           │
│  │  │  classify│  │ calendar  gmail  todo  soul    │   │           │
│  │  │  → EVO   │  │ darwin  amadeus  travel search  │   │           │
│  │  │  or      │  └────────────────────────────────┘   │           │
│  │  │  Claude) │                                       │           │
│  │  └──────────┘                                       │           │
│  │                                                      │           │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │           │
│  │  │ Scheduler │  │ Buffer   │  │ Data (JSON)      │  │           │
│  │  │ (60s tick)│  │ (10 msgs)│  │ todos.json       │  │           │
│  │  │ reminders │  │ per group│  │ soul.json        │  │           │
│  │  │ meetings  │  │ persisted│  │ audit.json       │  │           │
│  │  │ briefing  │  │          │  │ messages.json    │  │           │
│  │  │ backup    │  │          │  │ usage.json       │  │           │
│  │  └──────────┘  └──────────┘  │ interactions.jsonl│  │           │
│  │                               │ router-stats.jsonl│  │           │
│  │  ┌──────────────────────────┐ │ backups/          │  │           │
│  │  │ Circuit Breakers          │ └──────────────────┘  │           │
│  │  │ google | claude | weather │                       │           │
│  │  └──────────────────────────┘                       │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  clawd-dashboard (Rust native, eframe/egui)          │           │
│  │  ~/clawd-dashboard/target/release/clawd-dashboard   │           │
│  │  Connects to localhost:3000 API + SSE               │           │
│  └──────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
         │ direct ethernet (10.0.0.1 ↔ 10.0.0.2, 0.4ms)
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  EVO X2 NucBox (WiFi 192.168.1.230 / direct 10.0.0.2, user: james)│
│  AMD Ryzen AI MAX+ 395 + Radeon 8060S (gfx1151, RDNA 3.5)         │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  llama-server-main (port 8080)                       │           │
│  │  Qwen3-VL-30B-A3B Q4_K_M (Vulkan, vision, 32K ctx)  │           │
│  │  Swaps to Qwen3-Coder-30B-A3B overnight (22:00-06:00)│           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐          │
│  │ classifier:8081│ │ embed:8083     │ │ docling:8084   │          │
│  │ Qwen3-0.6B    │ │ nomic-embed    │ │ Granite-258M   │          │
│  └────────────────┘ └────────────────┘ └────────────────┘          │
│                                                                     │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐          │
│  │ memory:5100    │ │ SearXNG:8888   │ │ voice listener │          │
│  │ FastAPI        │ │ Docker search  │ │ Whisper+Piper  │          │
│  └────────────────┘ └────────────────┘ └────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘

External APIs:
  - MiniMax M2.7 (default cloud, Anthropic-compatible) — chat + tool use
  - Claude Opus 4.6 (premium, explicit request only) — fallback
  - Google Calendar v3, Gmail v1
  - Darwin (National Rail), BR Fares, Amadeus (hotels)
  - Open-Meteo (weather, free)
```

## Tech Stack

- **Runtime**: Node.js 20+ (ESM modules, `"type": "module"`)
- **WhatsApp**: `@whiskeysockets/baileys` v6.x
- **AI (cloud)**: `@anthropic-ai/sdk` — MiniMax M2.7 (default), Claude Opus 4.6 (premium)
- **AI (local)**: llama.cpp (Vulkan) on EVO X2 — see [EVO X2 Reference](docs/evo-x2-reference.md)
- **Google**: `googleapis` — Calendar v3, Gmail v1
- **Weather**: Open-Meteo (free, no API key)
- **Travel**: Darwin (trains), BR Fares (pricing), Amadeus (hotels)
- **Search**: SearXNG (self-hosted on EVO, Docker, port 8888)
- **Document parsing**: pdf-parse (PDFs), mammoth (DOCX/Word) — on Pi
- **Logging**: Pino (structured JSON)
- **Dashboard**: Rust native app (eframe/egui) — NOT Chromium
- **Data**: JSON files in `data/` — no database, no build step, no TypeScript

## File Structure

```
clawdbot/
├── CLAUDE.md               # Session protocol + design decisions (READ FIRST)
├── architecture.md          # This file — system overview
├── version.json             # Version number + release notes
├── package.json             # ESM project, dependencies
├── docs/
│   ├── data-flows.md        # Message routing, dashboard, scheduler, voice, evolution
│   ├── api-reference.md     # HTTP endpoints, tool access, infrastructure components
│   ├── deployment.md        # Deploy commands, systemd services, SSH patterns
│   └── evo-x2-reference.md  # Hardware facts, models, services, known issues
├── clawd-dashboard/         # Rust native dashboard (eframe/egui)
│   └── src/
│       ├── main.rs          # Main app: layout, panels, voice overlay, rendering
│       ├── api.rs           # HTTP/SSE client for clawdbot API
│       ├── models.rs        # Data models (deserialization from API)
│       ├── state.rs         # Shared app state (RwLock)
│       └── voice_overlay.rs # Voice state machine
├── evo-voice/               # Voice listener (runs on EVO X2, NOT Pi)
│   ├── voice_listener.py   # Main voice pipeline (mic→whisper→wake→classify→route)
│   └── clawdbot-voice.service
├── evo-memory/              # Memory service + dream mode (runs on EVO X2)
│   ├── main.py             # FastAPI server (port 5100)
│   ├── memory_store.py     # In-memory store + JSON persistence + dedup + TTL
│   ├── config.py           # Memory service configuration
│   ├── llm_client.py       # llama.cpp embedding/extraction client
│   ├── command_router.py   # Voice command routing
│   ├── seed_identity.py    # Identity memory seeding (immutable)
│   ├── dream_mode.py       # Overnight diary + fact/insight/verbatim extraction
│   ├── style_calibration.py # Weekly style calibration
│   └── whisper_service.py  # Whisper transcription service
├── evo-hooks/               # Claude Code hooks for evolution pipeline
│   └── scope-guard.sh      # PreToolUse scope enforcement
├── evo-overnight/           # Overnight coding scripts
├── evo-system/              # EVO system management
├── evo-evolve/              # Evolution pipeline scripts
│   └── run-evolution.sh    # Overnight evolution (one fix per session)
├── src/
│   ├── index.js             # Main entry: WhatsApp, HTTP server, shutdown
│   ├── config.js            # Env var loader with defaults and validation
│   ├── constants.js         # Fixed values (timeouts, buffer sizes, cooldowns)
│   ├── prompt.js            # System prompt + mode fragments + soul
│   ├── claude.js            # Anthropic SDK wrapper, tool loop, usage, EVO routing
│   ├── router.js            # Smart activity-based message router
│   ├── evo-llm.js           # EVO llama.cpp client (OpenAI-compatible API)
│   ├── evo-client.js        # Shared EVO HTTP client (all EVO communication)
│   ├── trigger.js           # Probabilistic response decision engine
│   ├── engagement.js        # Group classifier + mute + negative signal detection
│   ├── buffer.js            # Rolling context buffer, persistent DM buffer
│   ├── message-handler.js   # WhatsApp message processing
│   ├── message-cache.js     # Message deduplication (last 200 IDs)
│   ├── conversation-logger.js # JSONL logging for all group messages
│   ├── document-handler.js  # PDF/DOCX parsing + EVO summarisation
│   ├── scheduler.js         # 60s interval loop (delegates to src/tasks/)
│   ├── widgets.js           # Widget cache, SSE, Henry/SideGig/Email/Calendar/Weather
│   ├── http-server.js       # Express server setup
│   ├── sse.js               # Server-sent events for dashboard
│   ├── memory.js            # EVO memory service client
│   ├── lquorum-rag.js       # LQuorum working memory (keyword scanning, decay)
│   ├── evolution.js         # Evolution task store (queue, approval, rate limiting)
│   ├── evolution-executor.js # Claude Code CLI orchestration on EVO
│   ├── evolution-gate.js    # Scope validation, manifest checking
│   ├── quality-gate.js      # Opus review of complex responses
│   ├── overnight-report.js  # Dream + projects + self-improve report
│   ├── project-thinker.js   # Nightly project deep think
│   ├── usage-tracker.js     # Token cost tracking
│   ├── voice-handler.js     # Voice command processing
│   ├── session-repair.js    # WhatsApp session recovery
│   ├── interaction-log.js   # Conversation logging + feedback correlation
│   ├── router-telemetry.js  # Routing decision telemetry (JSONL)
│   ├── system-knowledge.js  # Seeds architecture into EVO memory
│   ├── logger.js            # Shared Pino structured logger
│   ├── weather.js           # Open-Meteo integration
│   ├── audit.js             # Append-only tool execution audit log
│   ├── circuit-breaker.js   # Generic circuit breaker
│   ├── self-improve/
│   │   └── cycle.js         # Overnight router keyword rule improvement
│   ├── tasks/               # Scheduled task modules
│   └── tools/
│       ├── definitions.js   # Tool JSON schemas (58 tools)
│       ├── handler.js       # Tool dispatch + audit logging + SSE
│       ├── projects.js      # Project CRUD
│       ├── calendar.js      # Google Calendar CRUD
│       ├── gmail.js         # Gmail search/read/draft/send
│       ├── todo.js          # Todo CRUD with async persistence
│       ├── soul.js          # Soul personality system
│       ├── darwin.js        # National Rail live departures
│       ├── amadeus.js       # Amadeus hotel search
│       ├── travel.js        # Train/accommodation booking links
│       └── search.js        # SearXNG web search
├── data/                    # Runtime data (gitignored)
│   ├── todos.json, soul.json, audit.json, messages.json, usage.json
│   ├── interactions.jsonl, feedback.jsonl, router-stats.jsonl
│   ├── system-knowledge.json, projects.json, lquorum-knowledge.json
│   ├── memory-cache.json, learned-rules.json, evolution-tasks.json
│   ├── conversation-logs/   # Daily JSONL per group (feeds dream mode)
│   ├── document-cache/      # Parsed document text cache
│   ├── document-logs/       # Document processing logs
│   └── backups/             # Daily backups (7-day retention)
├── auth_state/              # WhatsApp session (gitignored, critical)
├── test/                    # Test files
└── pi-system/               # Pi system management scripts
```

## Prompt Architecture

`prompt.js` builds the system prompt from:

1. **Base prompt** — identity, personality, capabilities, guardrails, travel knowledge
2. **Soul fragment** — dynamic personality sections from `data/soul.json`
3. **Soul guardrails** — rules for soul_propose/confirm flow
4. **Restricted sender fragment** — appended for non-owner senders
5. **Mode fragment** — random interjection (brief) or direct trigger (substantive)
6. **Date/time stamp** — current time in Europe/London
7. **Knowledge rules** — web search before factual responses; no emojis; `[SILENT]` marker
8. **LQuorum working memory** — warmed topic context from passive keyword scanning
9. **Professional group filter** — personal categories blocked in professional groups

## Henry Weekend System

Calendar events with "Henry" in the title are parsed by `widgets.js`:

1. Detects travel pattern from structured tags: `[driving]`, `[train]`, `[4-trip]`, or day-of-week inference
2. Checks Gmail for booking confirmations (LNER, Trainline, Booking.com, Airbnb)
3. Dashboard shows red/green badges for travel and accommodation status
4. Tapping a Henry card generates a planning prompt in chat
