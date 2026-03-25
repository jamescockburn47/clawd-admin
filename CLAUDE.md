# CLAUDE.md — Clawdbot (Clawd Monet)

> **READ THIS FIRST.** Every session must start by reading this file AND `architecture.md`. Do not skip.

## Design Decisions — BINDING

These are agreed decisions. Do not revisit, reverse, or work around them. If a decision needs changing, discuss with James first.

### Voice Pipeline
1. **Piper TTS for everything.** Orpheus-3B is too slow (8-12s generation). All TTS uses `speak_fast()` via Piper until a faster model or streaming solution exists. `speak()` delegates to `speak_fast()`. Do not re-add Orpheus TTS calls.
2. **Every voice command MUST produce audible output.** No silent failures. If a local action returns no speakable text, say "Done". If Claude returns nothing, say "Sorry, I couldn't get an answer."
3. **Mic flush after ALL TTS.** After any spoken output, wait `audio_duration + 0.5s` minimum before reopening mic. This prevents the mic picking up its own TTS from the Pi speaker.
4. **Follow-up mode after ALL spoken responses** — not just Claude. Any TTS output triggers follow-up listening window (10s).
5. **Local model handles everything the classifier routes locally.** Calendar, email summaries, etc. go to the Pi's `/api/voice-local` which must return human-readable `message` text (not raw counts or JSON). Do not restrict local routing — fix the response layer instead.
6. **Wake phrase ack is "Yes?"** via Piper. Not "How can I help?" — Piper mangles it. Keep it single-word.
7. **Whisper initial_prompt must include wake phrases** ("Hey Claude, hey Clawd") and example commands for decoder biasing.

### Architecture
8. **Bot code uses `evo-llm.js`** — OpenAI-compatible API. Legacy `ollama.js` was removed; do not reintroduce it.
9. **All EVO communication via direct ethernet** (`10.0.0.2`). Never use WiFi IP (`192.168.1.230`) for API calls.
10. **Dashboard is Rust/egui native app.** Not Chromium, not HTML. Source in `clawd-dashboard/src/`.
11. **Fix general before specific.** When a bug affects one action (e.g. calendar_list has no TTS), fix the general case (all actions must have TTS fallback) not just the specific action.

### Evolution Pipeline (DEPLOYED — 2026-03-25)
12. **Claude Code CLI on EVO** — v2.1.81 at `~/.local/bin/claude`. Runs headless via `-p "instruction" --dangerously-skip-permissions`. Works in git branches, never main. Repo at `~/clawdbot-claude-code/`.
13. **Data collection layers complete**: interaction logging (JSONL), WhatsApp reaction feedback, correction detection, self-improvement cycle logs, dream mode diary + facts + insights + verbatim.
14. **Local model does analysis only** — log crunching, pattern detection, health reports. Code mutation uses Claude Code CLI (cloud API) for Claude-level reasoning.

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
- **systemd service names**: `llama-server-main` (port 8080, Qwen3-VL-30B-A3B — text + vision, 32K ctx), `llama-server-classifier` (port 8081, Qwen3-0.6B), `llama-server-tts` (port 8082, Orpheus-3B), `llama-server-embed` (port 8083, nomic-embed-text — always on), `llama-server-docling` (port 8084, Granite-Docling-258M F16 — structured document parsing), `clawdbot-memory` (port 5100, FastAPI memory service). NOT `llama-main`/`llama-classifier`.
- **All EVO servers run 24/7.** `llama-sleep.timer` and `llama-wake.timer` have been disabled. All llama-server instances (main, classifier, embed) and memory service run continuously. Clawd must be responsive at all hours — group chats span timezones. Dream mode runs at 22:05 against the already-running LLM.
- **Ollama is still installed on EVO** but is NOT used by the memory service (which now uses llama.cpp). Ollama may still be running — can be stopped with `sudo systemctl stop ollama` if memory is needed.
- **Memory service uses llama.cpp for embeddings** (nomic-embed-text on port 8083) and fact extraction (Qwen3-30B on port 8080, daytime only). The `ollama_client.py` name is legacy — it talks to llama.cpp.
- **EVO main model is now Qwen3-VL-30B-A3B** (vision-language model). Same text performance as non-VL, adds image understanding. Context bumped to 32K (`-c 32768`). Old non-VL model backed up on EVO.
- **SearXNG runs on EVO** in Docker (port 8888). Free, self-hosted web search — no API key required. Replaces Brave Search for `web_search` tool.
- **Document parsing on Pi** uses `pdf-parse` (PDFs) and `mammoth` (DOCX/Word). Documents are summarised via EVO before sending to Claude (85% token reduction). Raw text cached for follow-up questions.
- **Bot code uses `evo-llm.js`** (OpenAI-compatible API via direct ethernet `http://10.0.0.2:8080`). Legacy `ollama.js` was removed from the tree.
- **Orpheus-3B TTS**: `llama-server-tts` service IS running on port 8082 (not disabled). Needs `--special` flag. Prompt format: `<|audio|>voice: text<|eot_id|>`. Uses `/v1/completions` endpoint. Outputs SNAC audio tokens decoded with Python `snac` library. Piper TTS is used for all voice output (faster); Orpheus is available but not called by default.
- **Optimised llama-server flags**: `--flash-attn on --mlock --no-mmap --cont-batching --batch-size 1024 --ubatch-size 512 --cache-type-k q8_0 --cache-type-v q8_0`. Requires `LimitMEMLOCK=infinity` in systemd unit.
- **SSH to EVO via direct link**: `ssh james@10.0.0.2` from Pi. Host key already in Pi's `known_hosts` for 10.0.0.2.
- **lemonade-sdk** provides prebuilt llama.cpp ROCm binaries for gfx1151 with all patches: https://github.com/lemonade-sdk/llamacpp-rocm/releases

## Quick Reference

| Key | Value |
|-----|-------|
| **Pi IP** | `192.168.1.211` LAN / `100.104.92.87` Tailscale (hostname: `cnc`) |
| **Pi user** | `pi` (NOT `james`) |
| **EVO X2 IP** | `10.0.0.2` direct ethernet (prefer) / `192.168.1.230` WiFi / `100.90.66.54` Tailscale |
| **EVO user** | `james` (NOT `pi`) |
| **EVO main LLM** | `http://10.0.0.2:8080` — Qwen3-VL-30B-A3B Q4_K_M (llama-server, Vulkan, vision-capable, `-c 32768`) |
| **EVO SearXNG** | `http://10.0.0.2:8888` — Docker, free web search (no API key) |
| **EVO classifier** | `http://10.0.0.2:8081` — Qwen3-0.6B Q8_0 |
| **EVO TTS** | `http://10.0.0.2:8082` — Orpheus-3B Q8_0 (SNAC audio tokens) |
| **EVO embeddings** | `http://10.0.0.2:8083` — nomic-embed-text-v1.5 Q8_0 (always on, 140MB) |
| **EVO docling** | `http://10.0.0.2:8084` — Granite-Docling-258M F16 (structured document parsing, 499MB) |
| **EVO memory** | `http://10.0.0.2:5100` — FastAPI memory service (clawdbot-memory) |
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
| **EVO Claude Code** | `~/.local/bin/claude` v2.1.81 (native install, headless via `-p`) |
| **EVO clawdbot repo** | `~/clawdbot-claude-code/` (git repo, branch `main`) |
| **Evolution tasks** | `data/evolution-tasks.json` (task queue for self-coding) |

## Session Protocol — MANDATORY

1. **Read `CLAUDE.md` and `architecture.md`** at the start of every session. **Cursor:** also read **`.cursorrules`** for deploy commands, SSH key path, and **agent timeout / split-step** notes (Pi `cargo build` needs a long wait or a separate terminal step).
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

1. **WhatsApp bot** — responds to messages via Baileys (unofficial WhatsApp Web API), routes to Claude or local model (EVO llama.cpp)
2. **Dashboard** — 3-column touchscreen kiosk UI showing Henry weekends, todos, side gig meetings, email, soul config, weather, usage alerts
3. **Image & document understanding** — downloads photos/docs sent via WhatsApp, images processed by EVO VL locally (Claude fallback), documents parsed (pdf-parse/mammoth) and summarised via EVO before Claude
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
- **AI (local)**: llama.cpp (Vulkan) on EVO X2 — Qwen3-VL-30B-A3B Q4_K_M (main, vision-capable, 32K ctx), Qwen3-0.6B Q8_0 (classifier), Orpheus-3B Q8_0 (TTS, currently disabled — too slow)
- **Google**: `googleapis` — Calendar v3, Gmail v1
- **Weather**: Open-Meteo (free, no API key, current conditions + forecast)
- **Travel**: Darwin (live trains), BR Fares (ticket prices), Amadeus (hotels)
- **Search**: SearXNG (self-hosted on EVO, Docker, port 8888, no API key)
- **Document parsing**: pdf-parse (PDFs), mammoth (DOCX/Word) — on Pi
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
- `EVO_LLM_URL` — EVO X2 main LLM URL (default `http://10.0.0.2:8080`)
- `EVO_CLASSIFIER_URL` — EVO X2 classifier URL (default `http://10.0.0.2:8081`)
- `EVO_TOOL_ENABLED` — `true`/`false` (default `true`)
- `WEATHER_ENABLED` — `true`/`false` (default `true`)
- `WEATHER_LOCATIONS` — comma-separated locations (default `London,York`). Uses Open-Meteo (free, no API key).
- `BRIEFING_ENABLED` — `true`/`false` (default `true`)
- `BRIEFING_TIME` — HH:MM in London timezone (default `07:00`)
- `LOG_LEVEL` — Pino log level (default `info`)

## Adding New Design Decisions

When a decision is made during a session (explicitly agreed with James, or arising from a bug fix that establishes a general rule), **add it to the Design Decisions section above immediately**. Number it sequentially. This is not optional — it's how continuity works across sessions.

### Process Rules
15. **Update CLAUDE.md in real-time.** Every decision, every agreed architectural change, every "don't do X" — add it to Design Decisions immediately, not at the end of the session. If you just learned something the hard way, write it down before moving on.
16. **Use superpowers skills.** Always use brainstorming before creative/design work. Use systematic-debugging before proposing fixes. Use verification-before-completion before claiming something works. These are not optional.
17. **Fix general before specific** (repeated for emphasis). When you find a bug in one place, ask "what's the general class of this bug?" and fix that. Don't patch individual symptoms.

### Group Chat & Social Intelligence
18. **Engagement classifier gates all group responses.** Every group message passes through the EVO 0.6B classifier which decides respond/silent. Direct mentions bypass the classifier. DMs are unaffected.
19. **Mute system: 10 min per-group cooldown.** "Shut up" / "go quiet" triggers mute. Only direct @mention breaks through. In-memory only, resets on restart.
20. **All group messages logged.** Every message in every group goes to `conversation-logs/` JSONL, not just Clawd's exchanges. This feeds dream mode.

### Dream Mode & Memory
21. **Dream mode runs overnight on EVO.** After 22:00 shutdown, the local model summarises the day's conversations from Clawd's first-person perspective. Extractive only — no inference, no extrapolation. Validated against source logs.
22. **Dream summaries are Clawd's long-term memory.** Stored in EVO memory service, searched and injected into Claude context (~500-800 tokens). Progressive compression: full → paragraph → one-liner over 30 days.

### Soul & Self-Awareness
23. **Reactive soul proposals via DM.** When Clawd detects negative reactions in groups, it proposes soul updates to James via private DM. Only James can approve. No one else can instruct Clawd's personality.
24. **System self-awareness is queryable.** Clawd knows about all its subsystems (dream mode, engagement classifier, memory layers, mute system) via system-knowledge.json and can explain them in first person.
25. **Self-explanation is natural, not technical.** Clawd describes itself like a person, not an architecture doc. "I dream overnight" not "the EVO X2 runs a summarisation cycle on JSONL logs." Technical details only when explicitly asked. No volunteering IP addresses, model names, or pipeline descriptions.
26. **Dream chaining.** Each night's dream receives the last 2-3 days' dream summaries as context, enabling cross-day pattern recognition. Today's actual conversations always take priority — prior dreams provide continuity, not bias.
27. **Group personality matches James.** Direct, compressed, sharp. No echoing, no "Great question!", no restating what someone just said, no unsolicited opinions. One message, not three. When told to shut up: silence immediately, no farewell, no "noted."
28. **Soul is advisory, classifier is the gate.** The engagement classifier (code-level, EVO 0.6B) decides whether Clawd responds to passive group messages. Soul/system prompt instructions shape *how* Clawd responds once the classifier has said yes. Do not put hard response-gating rules in soul — that's the classifier's job.
29. **Dream mode runs at 22:05 against the always-on LLM.** All servers run 24/7 — no sleep/wake timers. Dream service is a simple oneshot: pull logs from Pi, generate summaries, store in memory. Requires llama-server-main and clawdbot-memory to be running (systemd dependencies).
30. **Classifier fallback on EVO downtime.** If the engagement classifier (EVO 0.6B) is unreachable, fall back to simple keyword heuristic: only respond if message contains bot name + question mark or help request. This prevents total group silence during EVO downtime without over-responding.
31. **Memory service must be running on EVO for statefulness.** The memory service (`memory-service/main.py`, port 5100) is the backbone of dream storage, memory injection, and long-term learning. If it's not running, Clawd is effectively stateless. Verify it's deployed and enabled at boot on EVO.
32. **Owner authority is absolute.** James's instructions override all learned behaviours. Dream-generated soul proposals, mute rules, and social lessons NEVER restrict how Clawd responds to James. Clawd refusing an owner instruction is a bug.
33. **Intellectual backbone: adapt volume, never adapt accuracy.** Clawd adjusts delivery (speak less, be concise) based on social feedback. Clawd NEVER adjusts substantive positions to please people. If right, hold ground. If wrong, admit it immediately. Dream soul proposals cannot propose becoming more agreeable or avoiding correct arguments.
34. **Identity memories are immutable.** Category `identity` in memory service: never expired, never deduplicated, never superseded. Core facts about who Clawd is, who it serves, how it works. Protected in `memory_store.py`.
35. **All EVO servers run 24/7.** No sleep/wake timers. Clawd is in group chats across timezones and must be responsive at all hours. `llama-sleep.timer` and `llama-wake.timer` are disabled. GPU clock pinning (`power_dpm_force_performance_level=manual`) remains active.

### LQuorum Working Memory
36. **Passive keyword scanning warms working memory.** All group messages are scanned against a keyword map (18 topics). Matching topics are loaded from `data/lquorum-knowledge.json` into a working memory cache with hitCount tracking. No LLM call needed — pure keyword matching.
37. **Direct queries use `warmFromQuery()` with no length filter.** When someone asks a question, the full message is scanned against all topic keywords. Short messages are not filtered out for direct queries (unlike passive scanning which ignores very short messages).
38. **Working memory decays after 15 minutes.** Topics expire from working memory after 15 min of inactivity, extended for high hitCount. Knowledge is injected into context as recalled group discussion memory, not raw data — Clawd treats it as "I remember the group discussing X" not "according to the knowledge base."

### Image & Document Handling
39. **EVO VL handles images locally.** `forceClaude: false` for images. EVO Qwen3-VL-30B-A3B processes images on-device. No tools sent for vision queries. Claude is fallback only. Follow-up questions within 5 min reuse the last image per chat.
40. **Documents summarised via EVO before Claude.** PDFs and Word docs parsed on Pi (pdf-parse, mammoth), then summarised via EVO 30B. Claude receives the summary (85% token reduction), not raw text. Raw text cached for follow-ups. `documentWithCaptionMessage` caption extracted correctly.

### Web Search & Response Quality
41. **SearXNG for web search.** Docker on EVO port 8888. Free, self-hosted, no API key. `web_search` tool uses SearXNG. Knowledge rule in prompt forces web search before any factual response.
42. **Classifier silence via `[SILENT]` marker.** When Clawd is mentioned but not addressed, Claude produces `[SILENT]` which is filtered in index.js. No more "This message isn't for me" responses.
43. **max_tokens 4x for substantive responses.** Bumped from 2x to 4x the estimated response length (4000 tokens default) to prevent truncation.
44. **No emojis.** Global rule in prompt.js: never use emojis in any response.
45. **Professional group filtering.** Personal categories (travel, task, email) blocked in professional groups. Personal memory categories filtered from context in professional group chats.
46. **buildContext includes current message.** Fixed bug where triggerText was dropped when message buffer existed. Now includes `[Current message]` section.
47. **Startup message only on version change.** "Back online." message suppressed — only sends on version bumps.
48. **Google OAuth dead flag.** `googleAuthDead` flag in widgets.js stops retry spam when OAuth token is invalid_grant.

### Engagement & Response Quality (2026-03-24)
49. **Engagement BOT_NAMES excludes 'claude'.** `engagement.js` regex matches only `clawd|clawdbot`. General discussion about "Claude" (the AI) no longer triggers the engagement classifier. `trigger.js` already excluded it.
50. **LQuorum topics NOT injected into classifier.** The 0.6B classifier prompt no longer includes "Clawd has knowledge on X" — a small model is influenced by topic hints regardless of disclaimers. The classifier gates purely on whether Clawd is being addressed.
51. **Keywords run before complexity detection in router.** Keyword rules fire first — specific matches (overnight report, calendar, etc.) beat generic "long message" complexity classification. Prevents misrouting of known tool commands.
52. **Message deduplication.** `index.js` tracks last 200 message IDs. Baileys can deliver the same message via `messages.upsert` multiple times — duplicates are now silently dropped.
53. **Opus critique stripping uses --- divider.** If Opus's self-critique output contains `---` in the first 500 chars, everything before it is meta-commentary and gets stripped. Catches all preamble patterns without maintaining a regex denylist.
54. **Anti-slop writing rules in system prompt.** Banned phrases (hedging, filler, business jargon, approval filler), banned structures (binary contrasts, dramatic fragmentation, rhetorical questions), substance rule (every sentence must add new information). Prose over bullets unless genuinely discrete items.

### Dream Mode Housekeeping (2026-03-24)
55. **Dream orientation phase (Phase 0).** Before generating any diary, dream_mode.py fetches existing memories for the group. Injected as "What I already know" in the dream prompt. Prevents duplicate fact extraction.
56. **Pre-store dedup + contradiction detection.** Each extracted fact is checked against existing memories before storage. Similarity > 0.85 with high text overlap = skip (duplicate). Same topic but different content = supersede (contradiction).
57. **Stale memory pruning (Phase 5).** After diary generation, runs `/maintain` (expire + dedup) plus date-based staleness check. Machine-extracted memories older than 30 days with low access count are pruned. Protected categories (identity, person, legal, preference) exempt.
58. **Verbatim excerpt storage.** Dream prompt includes `[VERBATIM]` section — exact quotes worth preserving word-for-word. Stored with 0.95 confidence, category `general`, tagged `verbatim`. Enables precise recall alongside lossy diary summaries.

### Evolution Pipeline (2026-03-25)
59. **Self-coding via Claude Code CLI on EVO.** Claude Code v2.1.81 installed at `~/.local/bin/claude` on EVO. Repo at `~/clawdbot-claude-code/`. API key in `~/.bashrc`. All changes in git branches (never main).
60. **evolution_task WhatsApp tool.** Owner-only tool creates coding tasks. Tasks queued in `data/evolution-tasks.json`. Scheduler picks up pending tasks (max 3/day, 1/hour, 1 concurrent).
61. **DM approval required for all code changes.** Claude Code runs on EVO in a git branch. Diff sent to James via WhatsApp DM. "Reply approve/reject." No auto-deploy — ever.
62. **Deploy flow: merge → rsync → restart → health check.** On approve: merge branch to main on EVO, rsync changed files to Pi, restart clawdbot, verify service active after 5s. On health check failure: auto-revert commit, re-rsync, restart.
63. **Dream mode can create evolution tasks.** HTTP endpoint `POST /api/evolution/task` allows dream_mode.py to queue coding tasks when overnight analysis identifies a weakness.
64. **Tailscale on all machines.** Pi (100.104.92.87, `cnc`), EVO (100.90.66.54, `james-nucbox-evo-x2`). Enables SSH from anywhere without LAN. `--ssh` flag enabled for Tailscale SSH.

## Response Pipeline — Who Generates What

This is how messages flow. Do not change the routing logic without understanding this.

### Model Allocation

| Model | Location | Port | Role |
|-------|----------|------|------|
| **Qwen3-0.6B** | EVO X2 | 8081 | Engagement gating (YES/NO) + message classification |
| **Qwen3-VL-30B-A3B** | EVO X2 | 8080 | User-facing responses, vision/image understanding, document summarisation |
| **Claude Sonnet 4.6** | Cloud API | — | User-facing responses for complex/write/email queries (fallback for images) |
| **Memory Service** | EVO X2 | 5100 | Dream storage, memory search, context injection |
| **SearXNG** | EVO X2 | 8888 | Self-hosted web search (Docker, no API key) |

### Message Flow

```
WhatsApp message arrives
    │
    ├─ DM or @mention → ALWAYS respond
    │
    └─ Passive group message
        ├─ Mute trigger? → "Going quiet." + 10min mute
        ├─ Muted? → silent
        ├─ Negative signal? → DM James (async, no group response)
        └─ Engagement classifier (EVO 0.6B, port 8081)
            ├─ YES → proceed to response generation
            ├─ NO → silent
            └─ FAIL → keyword fallback (bot name + question = respond)

Response generation
    │
    ├─ Classification (keywords first, then EVO 0.6B if ambiguous)
    │   → Result: category + forceClaude flag
    │
    ├─ forceClaude = false (calendar read, todo, travel, chat, general)
    │   └─ EVO 30B (port 8080) generates response with tools
    │       └─ If EVO fails → falls back to Claude
    │
    └─ forceClaude = true (email, planning, multi-step, writes)
        └─ Claude API generates response with tools

Image handling
    └─ EVO VL (port 8080) handles images locally (no tools for vision queries)
        └─ If EVO fails → falls back to Claude vision
        └─ Follow-up questions within 5 min reuse last image per chat

Document handling (PDFs, DOCX)
    └─ Parsed on Pi (pdf-parse, mammoth) → summarised via EVO 30B
        └─ Claude receives summary (~85% token reduction)
        └─ Raw text cached for follow-up questions

Memory injection (before either model responds)
    └─ Search EVO memory service for relevant memories + dream summaries
        → Injected as ~500-800 tokens into system prompt
    └─ LQuorum working memory: passively warmed topics from keyword scanning
        → Injected as recalled group discussion context
```

### Key Rules
- **EVO VL 30B generates real user-facing responses** — not just classification. For simple queries, Claude is never called.
- **Claude handles all writes** — email, calendar mutation, soul changes. EVO only reads.
- **Images go to EVO VL first** — Qwen3-VL-30B-A3B handles vision locally. Claude is fallback only.
- **Documents summarised via EVO** before sending to Claude — 85% token reduction.
- **Web search uses SearXNG** on EVO (port 8888) — free, self-hosted, no API key.
- **If EVO is offline, everything falls back to Claude** — more expensive but never broken.
