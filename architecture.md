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
│  │  │ WhatsApp  │  │ API      │  │ - Dashboard HTML   │ │           │
│  │  │ WebSocket │  │ Client   │  │ - REST API         │ │           │
│  │  └─────┬─────┘  └────┬─────┘  │ - SSE events      │ │           │
│  │        │              │        └────────┬───────────┘ │           │
│  │        ▼              │                 │             │           │
│  │  ┌──────────┐  ┌─────┴──────┐  ┌───────┴──────────┐ │           │
│  │  │ Trigger   │  │ Tool       │  │ Widget Cache     │ │           │
│  │  │ Engine    │  │ Dispatcher │  │ (5 min TTL)      │ │           │
│  │  └──────────┘  │ + Audit    │  │ + Weather        │ │           │
│  │                 └─────┬──────┘  └──────────────────┘ │           │
│  │  ┌──────────┐        │                               │           │
│  │  │ Ollama   │  ┌─────┴──────────────────────────┐   │           │
│  │  │ (local)  │  │ Tools:                         │   │           │
│  │  │ qwen3.5  │  │ calendar  gmail  todo  soul    │   │           │
│  │  │ :4b      │  │ darwin  amadeus  travel search  │   │           │
│  │  └──────────┘  └────────────────────────────────┘   │           │
│  │                                                      │           │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │           │
│  │  │ Scheduler │  │ Buffer   │  │ Data (JSON)      │  │           │
│  │  │ (60s tick)│  │ (10 msgs)│  │ todos.json       │  │           │
│  │  │ reminders │  │ per group│  │ soul.json        │  │           │
│  │  │ meetings  │  │ persisted│  │ notified.json    │  │           │
│  │  │ briefing  │  │          │  │ audit.json       │  │           │
│  │  │ backup    │  │          │  │ messages.json    │  │           │
│  │  └──────────┘  └──────────┘  │ usage.json       │  │           │
│  │                               │ backups/          │  │           │
│  │  ┌──────────────────────────┐ └──────────────────┘  │           │
│  │  │ Circuit Breakers          │                       │           │
│  │  │ google | claude | weather │                       │           │
│  │  └──────────────────────────┘                       │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  systemd: ollama.service                              │           │
│  │  Model: qwen3.5:4b (~3GB RAM)                         │           │
│  └──────────────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────┐           │
│  │  Chromium Kiosk (Wayland, labwc autostart)           │           │
│  │  → http://localhost:3000/dashboard?token=...         │           │
│  └──────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘

External APIs:
  - Anthropic (Claude Sonnet 4.6) — chat responses + tool use
  - Google Calendar v3 — read/create/update events
  - Gmail v1 — search/read/draft/send emails
  - Darwin (National Rail) — live train departures
  - BR Fares — ticket pricing
  - Amadeus — hotel search
  - Brave Search — web search
  - OpenWeatherMap — current weather for configured locations

Local model:
  - Ollama (systemd) — routes simple conversational messages locally
  - qwen3.5:4b — 15s timeout, 300 max tokens, conservative routing
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
├── public/
│   └── dashboard.html       # Single-file dashboard (HTML+CSS+JS, ~1400 lines)
├── src/
│   ├── index.js             # Main entry: WhatsApp, HTTP server, image handling, shutdown
│   ├── config.js            # Env var loader with defaults and validation
│   ├── prompt.js            # System prompt + mode fragments + soul/restricted sender
│   ├── claude.js            # Anthropic SDK wrapper, tool loop, usage tracking, Ollama routing
│   ├── trigger.js           # Probabilistic response decision engine
│   ├── buffer.js            # Rolling context buffer, persistent owner DM buffer
│   ├── scheduler.js         # 60s interval: reminders, meetings, morning briefing, backup
│   ├── widgets.js           # Widget cache, SSE, Henry/SideGig/Email/Calendar/Weather
│   ├── logger.js            # Shared Pino structured logger
│   ├── ollama.js            # Local model routing heuristics + Ollama HTTP client
│   ├── weather.js           # OpenWeatherMap integration (current conditions)
│   ├── audit.js             # Append-only audit log for tool executions
│   ├── circuit-breaker.js   # Generic circuit breaker for API resilience
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
│       └── search.js         # Brave web search
├── data/                    # Runtime data (gitignored)
│   ├── todos.json           # Persistent todo items
│   ├── notified_meetings.json # Dedupe for meeting reminders
│   ├── soul.json            # Soul personality sections + history
│   ├── audit.json           # Tool execution audit log (last 1000 entries)
│   ├── messages.json        # Persisted owner DM context buffer
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
3. If image present and bot should respond: download via `downloadMediaMessage()`, base64 encode
4. `buffer.js` builds conversation context (last 10 messages)
5. `ollama.js` checks if message can be routed locally (short conversational, no tool triggers)
6. If local: Ollama responds directly (no API cost). If not: `claude.js` sends to Claude API with system prompt + tools + optional image
7. Claude may call tools (up to 5 loops) — `handler.js` dispatches, `audit.js` logs each call
8. Tool results fed back to Claude, final text response sent via Baileys
9. SSE broadcasts message to dashboard
10. Circuit breakers protect against cascading API failures

### Dashboard Data Flow

1. `widgets.js` fetches from Google Calendar + Gmail + OpenWeatherMap every 5 minutes
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

### Dashboard Rendering Constraints

- No emoji (Pi Chromium renders them as "?") — use HTML entities and CSS
- Touch targets must be 48px+ (Pi touchscreen)
- Status badges use CSS-styled circles with `&check;`, `!`, `&rarr;`, `&mdash;`
- Compact layout via `@media (max-height: 700px)` for the 600px screen
- On-screen keyboard provided for kiosk mode

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

## Deployment

### Deploy changes from Windows to Pi

```bash
# Deploy specific files
scp -i C:/Users/James/.ssh/id_ed25519 <file> pi@192.168.1.211:~/clawdbot/<path>

# Deploy directories
scp -i C:/Users/James/.ssh/id_ed25519 -r src/ public/ pi@192.168.1.211:~/clawdbot/

# Restart service
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"

# Check logs
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 50"

# Reload kiosk browser (kills and relaunches Chromium)
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "pkill chromium; sleep 2; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup chromium-browser --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --disable-restore-session-state --disable-features=TranslateUI --check-for-update-interval=31536000 --disable-gpu --password-store=basic --ozone-platform=wayland 'http://localhost:3000/dashboard?token=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM' > /dev/null 2>&1 &"
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
| GET | `/api/ollama` | Bearer token | Ollama health check (model availability) |
| POST | `/api/send` | None | Proactive message send (jid + message) |

### New Infrastructure Components

| Component | File | Purpose |
|-----------|------|---------|
| **Pino Logger** | `src/logger.js` | Structured logging (replaces console.log/error) |
| **Ollama Client** | `src/ollama.js` | Local model routing + HTTP client to Ollama |
| **Weather** | `src/weather.js` | OpenWeatherMap current conditions |
| **Audit Log** | `src/audit.js` | Append-only tool execution log (1000 entry cap) |
| **Circuit Breaker** | `src/circuit-breaker.js` | Protects Google/Claude/Weather API calls |
| **Buffer Persistence** | `src/buffer.js` | Owner DM context survives restarts |
| **Graceful Shutdown** | `src/index.js` | Flushes usage, todos, audit, buffers on SIGTERM |

### Ollama Local Model

Simple conversational messages (greetings, acknowledgements, chit-chat <200 chars without tool triggers) route to a local Qwen 3.5 4B model via Ollama. Everything else goes to Claude.

**Routing heuristic** (`ollama.js:shouldRouteLocally`):
- NEVER local: images, random mode, tool-trigger keywords, command verbs, complex questions
- LOCAL: short conversational messages without tool patterns
- Default: Claude (conservative — quality over savings)

**Safeguards**: 15-second timeout, 300 max tokens, seamless fallback to Claude on failure.
