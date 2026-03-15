# CLAUDE.md — Clawdbot (Clawd Monet)

> **READ THIS FIRST.** Every session must start by reading this file AND `architecture.md`. Do not skip.

## Quick Reference

| Key | Value |
|-----|-------|
| **Pi IP** | `192.168.1.211` (may change — check `known_hosts` or ping sweep if unreachable) |
| **Pi user** | `pi` (NOT `james`) |
| **SSH key** | `C:\Users\James\.ssh\id_ed25519` |
| **Pi project path** | `~/clawdbot` (NOT `~/clawdbot-claude-code`) |
| **Local project path** | `C:\Users\James\Downloads\clawdbot-claude-code` |
| **Pi service** | `sudo systemctl restart clawdbot` |
| **Dashboard URL** | `http://localhost:3000/dashboard?token=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM` |
| **Kiosk browser** | Chromium on Wayland, launched via `~/.config/labwc/autostart` |
| **Pi display** | 10.1" touchscreen, 1024x600 |
| **Model** | `claude-sonnet-4-6` |
| **Node** | v20+, ESM modules, `node --env-file=.env src/index.js` |

## Session Protocol — MANDATORY

1. **Read `CLAUDE.md` and `architecture.md`** at the start of every session.
2. **Verify Pi IP** before deploying — ping `192.168.1.211` first. If unreachable, check `~/.ssh/known_hosts` for alternatives.
3. **SSH command pattern**: `ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "command"`.
4. **SCP deploy pattern**: `scp -i C:/Users/James/.ssh/id_ed25519 <local_file> pi@192.168.1.211:~/clawdbot/<remote_path>`.
5. **After deploying**, restart the service: `sudo systemctl restart clawdbot`.
6. **To reload the kiosk browser**: kill and relaunch Chromium:
   ```bash
   pkill chromium; sleep 2; \
   export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; \
   nohup chromium-browser --kiosk --noerrdialogs --disable-infobars \
     --disable-session-crashed-bubble --disable-restore-session-state \
     --disable-features=TranslateUI --check-for-update-interval=31536000 \
     --disable-gpu --password-store=basic --ozone-platform=wayland \
     'http://localhost:3000/dashboard?token=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM' \
     > /dev/null 2>&1 &
   ```
7. **Never use `-uall` flag** with `git status` (can OOM on large repos).

## Known Gotchas

- **Pi Chromium cannot render emoji** (shows "?" for 🚗, ✅ etc.). Use HTML entities (`&check;`, `&rarr;`, `!`, `&mdash;`) and CSS-styled elements instead.
- **Google Calendar all-day events use exclusive end dates.** A Sat-Sun event has `end.date = Monday`. Subtract 1 day for display.
- **SCP doesn't merge** — it overwrites. Be careful with directory SCPs; send individual files when possible.
- **`home-hub.service`** has been removed from the Pi. Port 3000 is served by clawdbot.
- **Multiple scheduler starts**: The scheduler has a guard (`schedulerStarted` boolean) to prevent duplicate intervals on WhatsApp reconnects. Don't remove it.
- **Owner detection uses two formats**: `OWNER_JID` (phone `xxx@s.whatsapp.net`) and `OWNER_LID` (linked ID `xxx@lid`). Both must be checked.
- **Widget cache TTL is 5 minutes.** The scheduler reads cached data — no extra API calls.
- **The `OWNER_ONLY_TOOLS` set** in `claude.js` restricts certain tools from non-owner senders. Todo tools are deliberately NOT restricted — MG (James's wife) should be able to use them.

## Project Overview

WhatsApp admin assistant bot ("Clawd") running on a Raspberry Pi 5 with a 10.1" touchscreen dashboard. Serves as James Cockburn's personal assistant with calendar, email, travel, todo/reminders, and a soul/personality system.

### What It Does

1. **WhatsApp bot** — responds to messages via Baileys (unofficial WhatsApp Web API), routes to Claude or local model (Ollama)
2. **Dashboard** — 3-column touchscreen kiosk UI showing Henry weekends, todos, side gig meetings, email, soul config, weather, usage alerts
3. **Image understanding** — downloads photos sent via WhatsApp, base64 encodes, sends to Claude as vision input
4. **Tools** — calendar CRUD, email triage/draft/send, train fares/departures, hotel search, web search, todos with reminders, soul personality system
5. **Scheduler** — 60-second interval: todo reminders, side gig meeting alerts, morning briefing (daily WhatsApp summary), daily data backup
6. **SSE** — real-time dashboard updates when widgets/todos/soul change
7. **Audit logging** — append-only log of all tool executions with sender, input summary, success/failure
8. **Circuit breakers** — protect against cascading API failures (Google, Claude, Weather)

### Who Uses It

- **James** (owner) — full access to all tools via WhatsApp and dashboard
- **MG** (wife) — can use calendar reading, todo tools, web search, travel tools. Cannot use email, soul, or calendar mutation tools.

## Tech Stack

- **Runtime**: Node.js 20+ (ESM modules, `"type": "module"`)
- **WhatsApp**: `@whiskeysockets/baileys` v6.x
- **AI (cloud)**: `@anthropic-ai/sdk` — Claude Sonnet 4.6
- **AI (local)**: Ollama — Qwen 3.5 4B (routes simple conversational messages locally to save API costs)
- **Google**: `googleapis` — Calendar v3, Gmail v1
- **Weather**: OpenWeatherMap free tier (current conditions for configurable locations)
- **Travel**: Darwin (live trains), BR Fares (ticket prices), Amadeus (hotels), Brave Search (web)
- **Logging**: Pino (structured JSON logging, replaces all console.log/error)
- **Dashboard**: Single-file HTML (`public/dashboard.html`), served by clawdbot's HTTP server
- **Data persistence**: JSON files in `data/` (todos, notified meetings, soul, audit log, message buffer)
- **No database, no build step, no TypeScript**

## Version

Current version tracked in `version.json`. Bump on meaningful changes.

## Environment Variables

See `src/config.js` for all env vars. Key ones:
- `ANTHROPIC_API_KEY` — required, hard-fail if missing
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` — for Calendar/Gmail
- `OWNER_JID`, `OWNER_LID` — owner detection for tool restrictions
- `DASHBOARD_TOKEN` — auth token for dashboard HTTP endpoints
- `HTTP_PORT` — default 3000 on Pi
- `DARWIN_TOKEN`, `AMADEUS_CLIENT_ID/SECRET`, `BRAVE_API_KEY` — travel/search APIs
- `OLLAMA_ENABLED` — `true` to enable local model routing (default `false`)
- `OLLAMA_HOST` — Ollama API URL (default `http://localhost:11434`)
- `OLLAMA_MODEL` — model name (default `qwen3.5:4b`)
- `OLLAMA_TIMEOUT` — max ms to wait for local model (default `15000`)
- `OLLAMA_MAX_TOKENS` — max tokens from local model (default `300`)
- `WEATHER_API_KEY` — OpenWeatherMap API key
- `WEATHER_ENABLED` — `true`/`false` (default `true`)
- `WEATHER_LOCATIONS` — comma-separated locations (default `London,York`)
- `BRIEFING_ENABLED` — `true`/`false` (default `true`)
- `BRIEFING_TIME` — HH:MM in London timezone (default `07:00`)
- `LOG_LEVEL` — Pino log level (default `info`)

## Ollama Setup (Pi)

```bash
# Enable and start Ollama service
sudo systemctl enable ollama
sudo systemctl start ollama

# Pull the model (~2.5GB download, ~3GB RAM at runtime)
ollama pull qwen3.5:4b

# Verify
ollama run qwen3.5:4b "Hello"

# Then set in .env:
OLLAMA_ENABLED=true
```
