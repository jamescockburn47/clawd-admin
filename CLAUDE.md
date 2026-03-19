# CLAUDE.md — Clawdbot (Clawd Monet)

> **READ THIS FIRST.** Every session must start by reading this file AND `architecture.md`. Do not skip.

## Research Protocol — MANDATORY

- **ALWAYS search online** for hardware compatibility, driver support, library versions, and performance benchmarks. Never rely on training data for anything version-specific or hardware-specific.
- The EVO X2 runs an AMD Ryzen AI MAX+ 395 with Radeon 8060S (gfx1151, RDNA 3.5). This is bleeding-edge hardware — training data will be stale. Search for real-world reports, GitHub issues, and release notes.
- When researching ROCm, Vulkan, llama.cpp, or any GPU compute stack, search for the **current version** and **gfx1151 compatibility** explicitly.
- When researching model options, cast a **wide net** — check current leaderboards (LMSYS Arena, Open LLM Leaderboard), not just Qwen. Consider GLM, GPT-oss, Mistral, Falcon, MiMo, Nemotron, Kimi, DeepSeek, and any new entrants.

## Known EVO X2 Technical Facts — DO NOT RE-DISCOVER

These have been verified through testing. Do not waste time re-investigating:

- **ROCm/HIP segfaults on gfx1151** with ROCm 7.1.1. The crash is in `libhsa-runtime64.so` during model loading. `HSA_OVERRIDE_GFX_VERSION=11.0.0` does NOT fix it. ROCm 7.2 reportedly works but needs `-mllvm --amdgpu-unroll-threshold-local=600` compiler flag and `-DGGML_HIP_ROCWMMA_FATTN=ON`.
- **Vulkan backend works** and detects UMA (`uma: 1`). GPU fully offloaded (41/41 layers). Performance ceiling ~60-70 tok/s for 3B-active MoE models.
- **Qwen3.5-35B-A3B uses GDN (Gated Delta Networks)** — Vulkan has NO shader for GATED_DELTA_NET ops, causing CPU fallback and ~59 tok/s ceiling. Non-GDN models (Qwen3-30B-A3B, GLM-4.7-Flash) run fully on GPU.
- **GPU clock throttling**: Default DPM drops to 624MHz idle. Fix: `echo manual | sudo tee /sys/class/drm/card1/device/power_dpm_force_performance_level` then pin to highest state. GRUB `amdgpu.runpm=0` alone is NOT sufficient.
- **Direct Ethernet link** between Pi (10.0.0.1) and EVO (10.0.0.2) gives 0.4ms latency vs 124ms WiFi.
- **`huggingface-cli` not in nohup PATH** on EVO. Use `wget` with direct HuggingFace URLs, or use full path `~/.local/bin/huggingface-cli`. HF GGUF repos use subdirectory structure (e.g. `Q4_K_M/model-00001-of-00002.gguf`).
- **Thinking mode in Qwen3.5**: Use `--reasoning off` flag on llama-server. The `--chat-template-kwargs '{"enable_thinking":false}'` alone has a known bug. `--reasoning-budget 0` leaves residual `</think>` tags.
- **systemd service names**: `llama-server-main` (port 8080), `llama-server-classifier` (port 8081), `llama-server-tts` (port 8082, Orpheus-3B). NOT `llama-main`/`llama-classifier`.
- **Shutdown schedule**: `llama-sleep.timer` stops all 3 servers at 22:00. `llama-wake.timer` starts them at 05:00. Overnight reasoning task runs separately.
- **Bot code uses `evo-llm.js`** (NOT `ollama.js`). OpenAI-compatible API via direct ethernet `http://10.0.0.2:8080`. The old `ollama.js` is dead code.
- **Orpheus-3B TTS**: Needs `--special` flag on llama-server. Prompt format: `<|audio|>voice: text<|eot_id|>`. Uses `/v1/completions` endpoint. Outputs SNAC audio tokens decoded with Python `snac` library.
- **Optimised llama-server flags**: `--flash-attn on --mlock --no-mmap --cont-batching --batch-size 1024 --ubatch-size 512 --cache-type-k q8_0 --cache-type-v q8_0`. Requires `LimitMEMLOCK=infinity` in systemd unit.
- **SSH to EVO via direct link**: `ssh james@10.0.0.2` from Pi. Host key already in Pi's `known_hosts` for 10.0.0.2.
- **lemonade-sdk** provides prebuilt llama.cpp ROCm binaries for gfx1151 with all patches: https://github.com/lemonade-sdk/llamacpp-rocm/releases

## Quick Reference

| Key | Value |
|-----|-------|
| **Pi IP** | `192.168.1.211` (may change — check `known_hosts` or ping sweep if unreachable) |
| **Pi user** | `pi` (NOT `james`) |
| **EVO X2 IP** | `192.168.1.230` WiFi / `10.0.0.2` direct ethernet (prefer direct) |
| **EVO user** | `james` (NOT `pi`) |
| **EVO main LLM** | `http://10.0.0.2:8080` — Qwen3-30B-A3B Q4_K_M (llama-server, Vulkan) |
| **EVO classifier** | `http://10.0.0.2:8081` — Qwen3-0.6B Q8_0 |
| **EVO TTS** | `http://10.0.0.2:8082` — Orpheus-3B Q8_0 (SNAC audio tokens) |
| **SSH key** | `C:\Users\James\.ssh\id_ed25519` |
| **Pi project path** | `~/clawdbot` (NOT `~/clawdbot-claude-code`) |
| **Pi dashboard source** | `~/clawd-dashboard/` (Rust project, built with `cargo build --release`) |
| **Pi dashboard binary** | `~/clawd-dashboard/target/release/clawd-dashboard` |
| **EVO voice listener** | `~/clawdbot-memory/voice_listener.py` (NOT in `~/clawdbot/`) |
| **EVO voice service** | `clawdbot-voice.service` |
| **Local project path** | `C:\Users\James\Downloads\clawdbot-claude-code` |
| **Pi service** | `sudo systemctl restart clawdbot` |
| **Dashboard URL** | `http://localhost:3000/dashboard?token=VhPJmjOLM0A_t2idQrtfa3cHpSr_hBh0fgNxMr2TwUM` |
| **Dashboard** | Rust native app `clawd-dashboard` (NOT Chromium) |
| **Pi display** | 10.1" touchscreen, 1024x600 |
| **Model** | `claude-sonnet-4-6` |
| **Node** | v20+, ESM modules, `node --env-file=.env src/index.js` |

## Session Protocol — MANDATORY

1. **Read `CLAUDE.md` and `architecture.md`** at the start of every session.
2. **Verify Pi IP** before deploying — ping `192.168.1.211` first. If unreachable, check `~/.ssh/known_hosts` for alternatives.
3. **SSH command pattern**: `ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "command"`.
4. **SCP deploy pattern**: `scp -i C:/Users/James/.ssh/id_ed25519 <local_file> pi@192.168.1.211:~/clawdbot/<remote_path>`.
5. **After deploying Node.js files**, restart the service: `sudo systemctl restart clawdbot`.
6. **Never use `-uall` flag** with `git status` (can OOM on large repos).

## Deployment Commands — FOLLOW EXACTLY

### Deploy Node.js (clawdbot backend) to Pi
```bash
scp -i C:/Users/James/.ssh/id_ed25519 <local_file> pi@192.168.1.211:~/clawdbot/<remote_path>
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

### Deploy dashboard (Rust) to Pi
```bash
# 1. Copy source to Pi dashboard project
scp -i C:/Users/James/.ssh/id_ed25519 clawd-dashboard/src/main.rs pi@192.168.1.211:~/clawd-dashboard/src/main.rs
# 2. Build on Pi (cargo must be sourced)
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "source ~/.cargo/env; cd ~/clawd-dashboard && cargo build --release"
# 3. Relaunch dashboard
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "pkill clawd-dashboard 2>/dev/null; sleep 2; export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; nohup /home/pi/clawd-dashboard/target/release/clawd-dashboard > /tmp/clawd-dashboard.log 2>&1 &"
```

### Deploy voice listener to EVO X2 (via Pi SSH hop)
```bash
# 1. Copy to Pi as staging
scp -i C:/Users/James/.ssh/id_ed25519 evo-voice/voice_listener.py pi@192.168.1.211:/tmp/voice_listener.py
# 2. Hop from Pi to EVO
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "scp /tmp/voice_listener.py james@192.168.1.230:~/clawdbot-memory/voice_listener.py"
# 3. Restart voice service on EVO
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'sudo systemctl restart clawdbot-voice'"
```

### Take a screenshot of the Pi display
```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0; grim /tmp/screenshot.png"
scp -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211:/tmp/screenshot.png <local_path>
```

### Check logs
```bash
# Pi clawdbot
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "journalctl -u clawdbot --no-pager -n 50"
# Pi dashboard
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "tail -50 /tmp/clawd-dashboard.log"
# EVO voice listener
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@192.168.1.230 'journalctl -u clawdbot-voice -n 50 --no-pager'"
```

## Known Gotchas

- **Dashboard is a Rust native app**, not Chromium/HTML. Uses eframe/egui. Source in `clawd-dashboard/src/`. Built with `cargo build --release` on Pi. Binary at `~/clawd-dashboard/target/release/clawd-dashboard`.
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
- **Dashboard**: Rust native app (`clawd-dashboard/`) using eframe/egui — NOT Chromium, NOT HTML
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
