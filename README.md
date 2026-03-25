# Clawd (Clawd Monet)

A self-improving WhatsApp AI assistant running on a Raspberry Pi 5 with a touchscreen dashboard, backed by a mini PC running local AI models. Designed as a reference architecture for persistent, self-modifying AI agents.

## What Makes This Different

Most AI assistants are stateless API wrappers. Clawd is not.

**Clawd remembers.** Every conversation is logged. Every night, a local model reviews the day from Clawd's first-person perspective, extracts durable facts, identifies cross-conversation insights, and stores verbatim quotes worth preserving. Clawd wakes up the next morning with yesterday already digested.

**Clawd evolves.** A soul system tracks personality observations from group interactions. Only the owner can approve changes. A self-improvement cycle probes for weaknesses in message routing, proposes fixes, validates them against an eval suite, and applies improvements autonomously. An evolution pipeline lets Clawd modify its own source code via Claude Code CLI, with every change requiring human approval before deployment.

**Clawd reads the room.** An engagement classifier (0.6B parameter model) decides whether to respond to group messages. A mute system enforces silence when told to shut up. Negative reactions trigger private proposals to the owner, not public apologies.

## Architecture

Two machines connected via direct ethernet (sub-millisecond latency):

**Raspberry Pi 5** — orchestrator, WhatsApp client, HTTP server, dashboard
- Node.js 20+ (ESM), Baileys WhatsApp Web API
- Claude Sonnet 4.6 (cloud) for complex responses
- 58 tools: calendar, email, travel, todos, soul, memory, projects, web search, evolution
- Pino structured logging, circuit breakers, audit trail

**Local AI server** (AMD Ryzen AI MAX+ 395, Radeon 8060S) — local AI, memory, voice
- Qwen3-VL-30B-A3B (vision-language, 32K context, Vulkan backend, ~60-70 tok/s)
- Qwen3-0.6B classifier (engagement gating, message classification)
- nomic-embed-text-v1.5 (embeddings, always-on)
- FastAPI memory service (vector search, fact extraction, dream storage)
- SearXNG (self-hosted web search, no API key)
- Claude Code CLI (headless self-coding)
- Whisper STT + Piper TTS (voice interface)

**Dashboard** — Rust native app (eframe/egui), not Chromium
- 3-column touchscreen layout
- Real-time SSE updates
- Voice overlay (listening/processing/response states)

## Key Subsystems

### Memory & Dreams
- **Vector memory service** — hybrid search (keyword 35% + vector 40% + recency 15% + frequency 10%)
- **Dream mode** runs nightly — diary generation, fact extraction, insight synthesis, verbatim quote storage, soul observations
- **Orientation phase** — reads existing memories before writing new ones (prevents duplicates)
- **Pre-store dedup** — checks semantic similarity before storing (skips duplicates, supersedes contradictions)
- **Stale pruning** — removes machine-extracted memories older than 30 days with low access count
- **Identity memories** — immutable category, never expired or deduplicated

### Engagement & Groups
- **Classifier gate** — 0.6B model decides YES/NO for every passive group message
- **Mute system** — "shut up" triggers 10-minute per-group silence
- **Negative signal detection** — mocking, corrections, told-off patterns trigger private owner DM
- **Professional group filtering** — personal content blocked in work groups
- **Working memory** — passive keyword scanning across topic domains, 15-minute decay

### Self-Improvement
- **Router optimisation** — nightly cycle probes for missed keyword rules, validates against eval suite, applies improvements with rollback on accuracy drop
- **Quality gate** — Claude Opus 4.6 reviews every substantive response before sending, rewrites AI slop
- **Anti-slop rules** — banned phrases, banned structures, substance requirements in system prompt

### Evolution Pipeline
- **Chat trigger** — owner creates coding tasks via WhatsApp tool
- **Claude Code CLI** — runs headless in a git branch (never main)
- **Owner approval** — diff sent via WhatsApp DM, must reply "approve" before deployment
- **Auto-deploy** — merge branch, sync to Pi, restart service, health check, auto-rollback on failure
- **Dream integration** — overnight analysis can create coding tasks autonomously
- **Rate limited** — max 3 tasks/day, 1 concurrent, 1-hour cooldown

### Response Pipeline

```
WhatsApp message
  -> Dedup (last 200 message IDs)
  -> Trigger engine (direct mention, prefix, reply, random probability)
  -> Group: engagement classifier (YES/NO/fallback)
  -> Classification (keywords -> 0.6B classifier -> complexity -> fallback)
  -> Route: local model OR Claude API (based on category)
  -> Tool loop (up to 5 iterations, audit each call)
  -> Quality gate (substantive responses reviewed by Opus)
  -> Response sent
  -> Interaction logged, SSE broadcast
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ (ESM, no TypeScript, no build step) |
| WhatsApp | @whiskeysockets/baileys v6.x |
| Cloud AI | @anthropic-ai/sdk — Claude Sonnet 4.6 + Opus 4.6 (quality gate) |
| Local AI | llama.cpp (Vulkan) — Qwen3-VL-30B-A3B, Qwen3-0.6B, nomic-embed-text |
| Google | googleapis — Calendar v3, Gmail v1 |
| Weather | Open-Meteo (free, no API key) |
| Travel | Darwin (UK trains), BR Fares (tickets), Amadeus (hotels) |
| Search | SearXNG (self-hosted, Docker, no API key) |
| Documents | pdf-parse (PDFs), mammoth (DOCX) |
| Dashboard | Rust native app (eframe/egui) |
| Memory | FastAPI + JSON persistence + nomic embeddings |
| Voice | faster-whisper (STT) + Piper (TTS) |
| Logging | Pino (structured JSON) |
| Self-coding | Claude Code CLI (headless) |

## Setup

Requires a `.env` file with API keys and OAuth credentials. See `src/config.js` for all environment variables.

```bash
# Start via systemd (recommended)
sudo systemctl start clawdbot

# Or manually
node --env-file=.env src/index.js
```

## Project Structure

See `architecture.md` for the complete file tree, data flows, API endpoints, and deployment commands. See `CLAUDE.md` for design decisions, session protocol, and technical reference.

## License

Private project.
