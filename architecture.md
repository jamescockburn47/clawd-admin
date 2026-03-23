# Architecture — Clawdbot

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
│  │  │ meetings  │  │ persisted│  │ notified.json    │  │           │
│  │  │ briefing  │  │          │  │ audit.json       │  │           │
│  │  │ backup    │  │          │  │ messages.json    │  │           │
│  │  └──────────┘  └──────────┘  │ usage.json       │  │           │
│  │                               │ interactions.jsonl│  │           │
│  │  ┌──────────────────────────┐ │ router-stats.jsonl│  │           │
│  │  │ Circuit Breakers          │ │ backups/          │  │           │
│  │  │ google | claude | weather │ └──────────────────┘  │           │
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
│  │  systemd: llama-server-main.service (port 8080)      │           │
│  │  llama-server — Qwen3-VL-30B-A3B Q4_K_M (Vulkan)    │           │
│  │  Vision-language model (text + image understanding)  │           │
│  │  41/41 layers GPU-offloaded, ~60-70 tok/s            │           │
│  │  Context: 32K (-c 32768)                             │           │
│  │  OpenAI-compatible API: http://10.0.0.2:8080         │           │
│  │  Flags: --flash-attn on --mlock --no-mmap            │           │
│  │         --cont-batching --batch-size 1024             │           │
│  │         --ubatch-size 512 --cache-type-k q8_0         │           │
│  │         --cache-type-v q8_0 --reasoning off           │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  systemd: llama-server-classifier.service (port 8081)│           │
│  │  llama-server — Qwen3-0.6B Q8_0 (Vulkan)            │           │
│  │  Used by router.js for activity classification       │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  systemd: llama-server-tts.service (port 8082)       │           │
│  │  llama-server — Orpheus-3B Q8_0 (SNAC audio tokens)  │           │
│  │  --special flag, /v1/completions endpoint             │           │
│  │  Prompt: <|audio|>voice: text<|eot_id|>              │           │
│  │  ** CURRENTLY DISABLED — Piper TTS used instead **   │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  Timers: DISABLED (all servers run 24/7)              │           │
│  │  llama-sleep.timer — disabled                         │           │
│  │  llama-wake.timer  — disabled                         │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  Docker: SearXNG (port 8888)                          │           │
│  │  Self-hosted web search — no API key required         │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  systemd: clawdbot-voice.service                     │           │
│  │  python3 ~/clawdbot-memory/voice_listener.py         │           │
│  │                                                      │           │
│  │  Fifine USB Mic → PyAudio → Resample 44.1→16kHz     │           │
│  │  → Gain 3.5x → RMS VAD (threshold 1800)             │           │
│  │  → Record until 1.2s silence or 12s max              │           │
│  │  → faster-whisper (distil-small.en, CPU, int8)       │           │
│  │  → Wake phrase detect ("clawd"/"claude"/variants)    │           │
│  │  → Classify via llama-server-classifier (port 8081)  │           │
│  │  → Route: local (EVO tools) or Claude (via Pi API)   │           │
│  │  → Piper TTS for all voice output                    │           │
│  └──────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘

EVO **memory-service** (FastAPI, port 5100): memory CRUD, Whisper transcribe, `/route-command` for voice (keywords + optional llama classifier on :8081).

External APIs:
  - Anthropic (Claude Sonnet 4.6) — chat responses + tool use (fallback for images)
  - Google Calendar v3 — read/create/update events
  - Gmail v1 — search/read/draft/send emails
  - Darwin (National Rail) — live train departures
  - BR Fares — ticket pricing
  - Amadeus — hotel search
  - Open-Meteo — weather forecasts (free, no API key)

Local model (EVO X2):
  - llama.cpp (Vulkan backend) — routes messages via smart classifier
  - Qwen3-VL-30B-A3B Q4_K_M — main model, tool calling + vision, OpenAI-compatible API, 32K ctx
  - Qwen3-0.6B Q8_0 — lightweight classifier for activity routing
  - SearXNG (Docker, port 8888) — self-hosted web search, no API key
  - Piper TTS — text-to-speech for voice responses

Document parsing (Pi):
  - pdf-parse — PDF text extraction
  - mammoth — DOCX/Word document conversion
  - Documents summarised via EVO before Claude (85% token reduction)
```

## File Structure

```
clawdbot/
├── CLAUDE.md               # Session protocol + quick reference (READ FIRST)
├── architecture.md          # This file — system design
├── version.json             # Version number + release notes
├── package.json             # ESM project, dependencies
├── Dockerfile               # Docker deployment option
├── docker-compose.yml       # Docker service definition
├── get-google-token.js      # One-time Google OAuth token helper
├── clawd-dashboard/         # Rust native dashboard (eframe/egui)
│   └── src/
│       ├── main.rs          # Main app: layout, panels, voice overlay, rendering
│       ├── api.rs           # HTTP/SSE client for clawdbot API
│       ├── models.rs        # Data models (deserialization from API)
│       ├── state.rs         # Shared app state (RwLock)
│       └── voice_overlay.rs # Voice state machine (Hidden/Listening/Processing/Response/Toast)
├── evo-voice/               # Voice listener (runs on EVO X2, NOT Pi)
│   ├── voice_listener.py   # Main voice pipeline (mic→whisper→wake→classify→route)
│   └── clawdbot-voice.service # systemd unit file
├── public/
│   └── dashboard.html       # Legacy HTML dashboard (superseded by Rust app)
├── src/
│   ├── index.js             # Main entry: WhatsApp, HTTP server, image handling, shutdown
│   ├── config.js            # Env var loader with defaults and validation
│   ├── prompt.js            # System prompt + mode fragments + soul/restricted sender
│   ├── claude.js            # Anthropic SDK wrapper, tool loop, usage tracking, EVO routing
│   ├── router.js            # Smart activity-based message router (keywords → classifier → fallback)
│   ├── evo-llm.js           # EVO X2 llama.cpp client (OpenAI-compatible API, tool calling)
│   ├── trigger.js           # Probabilistic response decision engine
│   ├── buffer.js            # Rolling context buffer, persistent owner DM buffer
│   ├── scheduler.js         # 60s interval: reminders, meetings, morning briefing, backup
│   ├── widgets.js           # Widget cache, SSE, Henry/SideGig/Email/Calendar/Weather
│   ├── logger.js            # Shared Pino structured logger
│   ├── weather.js           # Open-Meteo integration (free, no API key)
│   ├── audit.js             # Append-only audit log for tool executions
│   ├── circuit-breaker.js   # Generic circuit breaker for API resilience
│   ├── memory.js            # EVO X2 memory service client (store/search/list)
│   ├── interaction-log.js   # Conversation-level interaction logging + feedback correlation
│   ├── router-telemetry.js  # Routing decision telemetry (JSONL stats)
│   ├── system-knowledge.js  # Seeds architecture knowledge into EVO memory service
│   ├── lquorum-rag.js       # LQuorum working memory — passive keyword scanning, topic warming, decay
│   ├── self-improve/
│   │   └── cycle.js         # Autonomous overnight self-improvement for router keyword rules
│   └── tools/
│       ├── definitions.js   # Tool JSON schemas for Claude (all tool definitions)
│       ├── handler.js        # Tool dispatch + audit logging + SSE broadcast
│       ├── calendar.js       # Google Calendar CRUD (with exclusive end date fix)
│       ├── gmail.js          # Gmail search/read/draft/confirm-send
│       ├── todo.js           # Todo CRUD, in-memory cache + debounced async persistence
│       ├── soul.js           # Soul personality system (read/propose/confirm)
│       ├── darwin.js         # National Rail live departures
│       ├── amadeus.js        # Amadeus hotel search
│       ├── travel.js         # Train/accommodation booking link generators
│       └── search.js         # SearXNG web search (self-hosted on EVO, Docker)
├── data/                    # Runtime data (gitignored)
│   ├── todos.json           # Persistent todo items
│   ├── notified_meetings.json # Dedupe for meeting reminders
│   ├── soul.json            # Soul personality sections + history
│   ├── audit.json           # Tool execution audit log (last 1000 entries)
│   ├── messages.json        # Persisted owner DM context buffer
│   ├── interactions.jsonl   # Conversation-level interaction log (evolution pipeline)
│   ├── router-stats.jsonl   # Routing decision telemetry
│   ├── system-knowledge.json # Structured self-knowledge for EVO memory
│   └── backups/             # Daily backups (last 7 days)
│       └── YYYY-MM-DD/      # todos.json, soul.json, soul_history.json
├── auth_state/              # WhatsApp session + usage.json (gitignored, critical)
├── test/                    # Test files
├── docs/                    # Additional documentation
└── clawdbot-instructions/   # Original build instructions (historical)
    └── CLAUDE.md            # Original Monet character spec (superseded)
```

## Key Data Flows

### WhatsApp Message → Response

1. Baileys receives message via WebSocket
2. `trigger.js` decides: direct (prefix/mention/reply), random (probability), or ignore
3. If image present: download via `downloadMediaMessage()`, base64 encode → route to EVO VL (Claude fallback). Follow-up questions within 5 min reuse last image per chat
3b. If document (PDF/DOCX): parse on Pi (pdf-parse/mammoth) → summarise via EVO 30B → Claude receives summary (85% token reduction). Raw text cached for follow-ups
4. `buffer.js` builds conversation context (last 10 messages, includes `[Current message]` section)
5. `router.js` classifies message activity category (keyword heuristics → EVO classifier on port 8081 → fallback)
6. If EVO available and not forced to Claude: `evo-llm.js` sends to Qwen3-30B-A3B via OpenAI-compatible API with category-scoped tools
7. If EVO unavailable, empty response, or must-use-Claude: `claude.js` sends to Claude API with full system prompt + tools + optional image
8. Claude/EVO may call tools (up to 5 loops) — `handler.js` dispatches, `audit.js` logs each call
9. Tool results fed back, final text response sent via Baileys
10. `interaction-log.js` records the full request/response pair with routing metadata
11. SSE broadcasts message to dashboard
12. Circuit breakers protect against cascading API failures

### Dashboard Data Flow

1. `widgets.js` fetches from Google Calendar + Gmail + Open-Meteo every 5 minutes
2. Results cached in memory (`widgetCache`, 5-min TTL), circuit breakers return stale cache on API failure
3. Dashboard loads via HTTP GET `/api/widgets`, `/api/todos`, `/api/soul`
4. Real-time updates via SSE (`/api/events`) for widgets, todos, soul, messages
5. Dashboard shows: weather in header, usage alerts (amber/red), 3-state status dot
6. Dashboard chat input → POST `/api/chat` → Claude → response

### Scheduler (Proactive Notifications)

1. Runs every 60 seconds (lightweight in-process check)
2. **Todo reminders**: reads in-memory todos, finds items with past reminder times, sends WhatsApp, marks reminded
3. **Side gig meetings**: reads widget cache (no API call), finds meetings 25-35 min away, sends WhatsApp, dedupes
4. **Morning briefing**: once daily at configured time (default 07:00 London), sends weather + calendar + todos + Henry status via WhatsApp
5. **Daily backup**: at 3 AM, copies todos.json, soul.json, soul_history.json to `data/backups/YYYY-MM-DD/`, keeps last 7 days
6. Zero token cost — no Claude API calls

### Voice Command Flow (EVO X2 → Pi)

1. Fifine USB mic on EVO captures audio at 44.1kHz via PyAudio
2. Resampled to 16kHz, gain applied (3.5x)
3. RMS-based speech detection (threshold 1800 after gain)
4. Records until 1.2s silence or 12s max
5. Trims silence, sends to faster-whisper (distil-small.en model, CPU, int8)
6. Rejects Whisper hallucinations ("thank you", single short words, etc.)
7. Checks first 45 chars for wake phrase (clawd/claude/claud/clawed/klawd/cloud/claw)
8. If wake phrase found: strips it, classifies command via llama-server-classifier (port 8081)
9. Routes locally (EVO tools via Qwen3-30B-A3B) or to Pi `/api/voice-command` for Claude
10. Response text sent to Piper TTS for spoken output
11. Dashboard shows voice overlay (Listening → Processing → Response → auto-dismiss)

**Key tuning parameters** (env vars on EVO, defaults in voice_listener.py):
- `MIC_GAIN=3.5` — amplification factor for Fifine USB mic
- `SPEECH_THRESHOLD=1800` — RMS level to trigger recording (must exceed ambient noise floor)
- `SILENCE_DURATION=1.2` — seconds of silence before stopping recording
- `WHISPER_MODEL=distil-small.en` — faster-whisper model (English-only, optimised)

## Dashboard Layout

3-column layout on the 1024x600 Pi touchscreen:

```
┌──────────────┬──────────────┬──────────────┐
│ LEFT         │ CENTER       │ RIGHT        │
│ (swipeable)  │ (static)     │ (swipeable)  │
│              │              │              │
│ Page 0:      │ Todos &      │ Page 0:      │
│ Henry        │ Reminders    │ Side Gig     │
│ Weekends     │              │ Meetings     │
│              │ - Active     │              │
│ Page 1:      │   (tap done) │ Page 1:      │
│ Calendar     │ - Completed  │ Email        │
│ (14 days)    │              │              │
│              │              │ Page 2:      │
│ Tap to       │              │ Soul Config  │
│ expand       │              │              │
│ events       │              │ Tap to       │
│              │              │ expand items │
└──────────────┴──────────────┴──────────────┘
```

- **Left panel** swipes between Henry Weekends (with travel/accommodation badges) and Calendar
- **Center panel** is static — shows todos with tap-to-complete checkboxes
- **Right panel** swipes between Side Gig, Email, and Soul
- **Calendar/Email/Side Gig items** are all tap-to-expand for details
- **Henry cards** tap to auto-generate a planning prompt in the chat bar
- **Bottom bar**: last Clawd message + chat input + voice activation (wake word "Clawd")

### Dashboard Rendering (Rust/egui)

- **Native app**, not a browser — no HTML/CSS/JS constraints
- Uses eframe/egui with Wayland backend on Pi
- Touch targets must be 48px+ (Pi touchscreen)
- Status badges: solid green/red backgrounds with black text for contrast
- Layout: left 42%, center 30%, right 28% of 1024px
- Voice overlay: compact bottom-anchored cards (not full-screen modals)
- Build: `source ~/.cargo/env; cd ~/clawd-dashboard && cargo build --release`
- Launch: `export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup ~/clawd-dashboard/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 &`

## Message Routing Architecture

Messages are routed through a multi-layer classification system before reaching an LLM:

```
Message → Complexity check → Keyword heuristics → EVO classifier (port 8081) → Fallback
                │                    │                      │                      │
                ▼                    ▼                      ▼                      ▼
          Must-use-Claude      Category match         Category match         Default: Claude
          (images, long,       (fast, no API          (Qwen3-0.6B,
           tool-heavy)          cost)                  ~50ms)
                                     │                      │
                                     ▼                      ▼
                              ┌─────────────────────────────────┐
                              │ Category → Tool set scoping      │
                              │ calendar, task, travel, email,   │
                              │ recall, planning, conversational,│
                              │ general_knowledge, system        │
                              └──────────────┬──────────────────┘
                                             │
                              ┌──────────────┴──────────────────┐
                              │                                  │
                              ▼                                  ▼
                     EVO X2 (port 8080)                    Claude API
                     Qwen3-30B-A3B                      (fallback or forced)
                     Category-scoped tools              Full tool access
```

**Router telemetry** (`router-telemetry.js`) logs every routing decision to `data/router-stats.jsonl` for analysis. The **self-improvement cycle** (`self-improve/cycle.js`) runs overnight, probing for missed keyword rules, validating against an eval suite, and applying improvements automatically.

## Tool Access Control

`OWNER_ONLY_TOOLS` in `claude.js` restricts these tools to James only:

| Tool | Restricted? | Notes |
|------|------------|-------|
| `gmail_*` | Yes | Email is private |
| `soul_propose/confirm` | Yes | Personality changes are owner-only |
| `calendar_create/update` | Yes | Calendar mutations are owner-only |
| `calendar_list/find_free_time` | No | Reading is safe for all |
| `todo_*` | No | MG can add/complete todos |
| `train_*`, `hotel_search` | No | Travel tools open to all |
| `web_search` | No | Search open to all |

## Henry Weekend System

Calendar events with "Henry" in the title are parsed by `widgets.js`:

1. Detects travel pattern from structured tags in event description:
   - `[driving]` → no train needed, no accommodation
   - `[train]` → default train pattern
   - `[4-trip]` → 4-leg weekend
   - Falls back to day-of-week inference if no tags
2. Checks Gmail for booking confirmations (LNER, Trainline, Booking.com, Airbnb, etc.)
3. Dashboard shows red/green badges for travel and accommodation status
4. Tapping a Henry card generates a planning prompt in the chat bar

## Prompt Architecture

`prompt.js` builds the system prompt from:

1. **Base prompt** — identity, personality, capabilities, guardrails, travel knowledge
2. **Soul fragment** — dynamic personality sections from `data/soul.json`
3. **Soul guardrails** — rules for soul_propose/confirm flow
4. **Restricted sender fragment** — appended for non-owner senders (limits tool access description)
5. **Mode fragment** — random interjection (brief) or direct trigger (substantive)
6. **Date/time stamp** — current time in Europe/London
7. **Knowledge rules** — web search required before factual responses; no emojis; `[SILENT]` marker for non-addressed mentions
8. **LQuorum working memory** — warmed topic context from passive keyword scanning of group messages
9. **Professional group filter** — personal categories (travel, task, email) and personal memory blocked in professional groups

## Deployment

### Deploy Node.js (clawdbot backend) to Pi

```bash
scp -i C:/Users/James/.ssh/id_ed25519 <file> pi@192.168.1.211:~/clawdbot/<path>
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

### Deploy dashboard (Rust) to Pi

```bash
# Copy source
scp -i C:/Users/James/.ssh/id_ed25519 clawd-dashboard/src/main.rs pi@192.168.1.211:~/clawd-dashboard/src/main.rs
# Build (must source cargo env)
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "source ~/.cargo/env; cd ~/clawd-dashboard && cargo build --release"
# Relaunch
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "pkill clawd-dashboard 2>/dev/null; sleep 2; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup ~/clawd-dashboard/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 &"
```

### Deploy voice listener to EVO X2 (via Pi SSH hop)

```bash
# Stage on Pi, then copy to EVO
scp -i C:/Users/James/.ssh/id_ed25519 evo-voice/voice_listener.py pi@192.168.1.211:/tmp/voice_listener.py
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "scp /tmp/voice_listener.py james@192.168.1.230:~/clawdbot-memory/voice_listener.py"
# Restart voice service on EVO
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'sudo systemctl restart clawdbot-voice'"
```

### Check logs

```bash
# Pi clawdbot
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 50"
# Pi dashboard
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "tail -50 /tmp/clawd-dashboard.log"
# EVO voice listener
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'journalctl -u clawdbot-voice -n 50 --no-pager'"
# EVO llama-server main
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@10.0.0.2 'journalctl -u llama-server-main -n 50 --no-pager'"
# EVO llama-server classifier
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@10.0.0.2 'journalctl -u llama-server-classifier -n 50 --no-pager'"
```

### Pi systemd service

```ini
# /etc/systemd/system/clawdbot.service
[Unit]
Description=Clawdbot WhatsApp Admin Assistant
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/clawdbot
ExecStart=/usr/bin/node --env-file=.env src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### EVO X2 systemd services

```ini
# /etc/systemd/system/llama-server-main.service
# Qwen3-VL-30B-A3B Q4_K_M on port 8080 (Vulkan backend, vision-capable, 32K ctx)
# Requires LimitMEMLOCK=infinity for --mlock flag

# /etc/systemd/system/llama-server-classifier.service
# Qwen3-0.6B Q8_0 on port 8081 (Vulkan backend)
# Lightweight classifier for activity routing

# /etc/systemd/system/llama-server-tts.service
# Orpheus-3B Q8_0 on port 8082 (--special flag)
# Currently disabled — Piper TTS used instead

# /etc/systemd/system/llama-sleep.timer — DISABLED (all servers run 24/7)
# /etc/systemd/system/llama-wake.timer  — DISABLED (all servers run 24/7)

# Docker: SearXNG on port 8888 — self-hosted web search, no API key
```

### API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/dashboard` | Token (query param) | Serves dashboard HTML |
| GET | `/api/status` | Bearer token | Connection status, uptime, memory, lastActivity |
| GET | `/api/widgets` | Bearer token | Cached widget data (incl. weather) |
| POST | `/api/widgets/refresh` | Bearer token | Force widget refresh |
| GET | `/api/events` | Token (query param) | SSE event stream |
| POST | `/api/chat` | Bearer token | Send message to Clawd |
| GET | `/api/usage` | Bearer token | Token usage + cost stats |
| GET | `/api/soul` | Bearer token | Soul data + pending + history |
| POST | `/api/soul/reset` | Bearer token | Reset all soul sections |
| GET | `/api/todos` | Bearer token | All todo items |
| POST | `/api/todos/complete` | Bearer token | Complete a todo by ID |
| GET | `/api/messages` | Bearer token | Recent owner DM messages |
| GET | `/api/audit` | Bearer token | Last 50 tool execution audit entries |
| GET | `/api/quality` | Bearer token | Interaction quality summary (evolution pipeline) |
| GET | `/api/evo` | Bearer token | EVO X2 llama-server health check |
| GET | `/api/memory/status` | Bearer token | EVO X2 + memory service stats |
| GET | `/api/memory/list` | Bearer token | All stored memories |
| POST | `/api/memory/search` | Bearer token | Search memories by query |
| POST | `/api/memory/note` | Bearer token | Store a quick note |
| PUT | `/api/memory/:id` | Bearer token | Update a memory by ID |
| DELETE | `/api/memory/:id` | Bearer token | Delete a memory by ID |
| POST | `/api/voice-command` | Bearer token | Voice command from EVO (text + source) |
| POST | `/api/voice-status` | Bearer token | Voice status events from EVO (listening/processing/etc.) |
| POST | `/api/voice-local` | Bearer token | Locally-routed voice command (action + params) |
| POST | `/api/desktop-mode` | None | Kill kiosk Chromium to expose Pi desktop |
| POST | `/api/send` | None | Proactive message send (jid + message) |

### Infrastructure Components

| Component | File | Purpose |
|-----------|------|---------|
| **Pino Logger** | `src/logger.js` | Structured logging (replaces console.log/error) |
| **EVO LLM Client** | `src/evo-llm.js` | llama.cpp OpenAI-compatible API client + tool calling |
| **Router** | `src/router.js` | Smart activity classification (keywords → classifier → fallback) |
| **Router Telemetry** | `src/router-telemetry.js` | Routing decision stats (JSONL) |
| **Interaction Log** | `src/interaction-log.js` | Conversation-level logging + feedback correlation |
| **System Knowledge** | `src/system-knowledge.js` | Seeds architecture docs into EVO memory service |
| **Self-Improve Cycle** | `src/self-improve/cycle.js` | Overnight autonomous router keyword rule improvement |
| **Memory Client** | `src/memory.js` | EVO X2 memory service (store/search/list/delete) |
| **LQuorum Working Memory** | `src/lquorum-rag.js` | Passive keyword scanning, topic warming, decay (18 topics, 15 min TTL) |
| **Weather** | `src/weather.js` | Open-Meteo weather forecasts (free, no API key) |
| **Audit Log** | `src/audit.js` | Append-only tool execution log (1000 entry cap) |
| **Circuit Breaker** | `src/circuit-breaker.js` | Protects Google/Claude/Weather API calls |
| **Buffer Persistence** | `src/buffer.js` | Owner DM context survives restarts |
| **Graceful Shutdown** | `src/index.js` | Flushes usage, todos, audit, buffers on SIGTERM |

### EVO X2 Local Model

Messages are routed to EVO X2 via a smart activity-based classifier. The router (`router.js`) first tries keyword heuristics, then falls back to the Qwen3-0.6B classifier on port 8081 to determine the activity category (calendar, task, travel, email, recall, planning, conversational, general_knowledge, system). Each category maps to a scoped tool set, reducing hallucination risk.

The main model (Qwen3-VL-30B-A3B Q4_K_M) runs on llama.cpp with the Vulkan backend, fully GPU-offloaded (41/41 layers) on the Radeon 8060S. It exposes an OpenAI-compatible API at `http://10.0.0.2:8080` and supports function calling for tool use. The VL variant adds vision/image understanding with identical text performance. Context is 32K tokens (`-c 32768`).

**Routing logic** (`claude.js` + `router.js` + `evo-llm.js`):
- ALWAYS Claude: forced-Claude flag, random mode
- TRY EVO first: all other messages when EVO is healthy, including images (EVO VL) and documents
- FALLBACK to Claude: on EVO timeout, empty response, or error
- Category-scoped tools reduce the tool set sent to EVO per message

**Performance**: ~60-70 tok/s for non-GDN MoE models on Vulkan. Direct ethernet link (10.0.0.1 ↔ 10.0.0.2) gives 0.4ms network latency.

**Safeguards**: health check before each call, seamless fallback to Claude on any failure, router telemetry logging for analysis.
