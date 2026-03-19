# System Knowledge Architecture — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give Clawd full self-awareness by storing architecture knowledge as searchable memories in the EVO memory service, enabling local-first answering of system queries.

**Architecture:** Structured system knowledge seeded as memories (category: `system`) on Pi startup. New SYSTEM router category catches architecture/system queries, fetches memories + live status, routes to local model first with Claude fallback.

**Tech Stack:** Existing EVO memory service (port 5100), Ollama qwen3.5:35b, Node.js on Pi.

---

## Approach: Structured Knowledge + Memory Service Hybrid

### Components

1. **`src/system-knowledge.js`** — generates system knowledge entries, seeds them to EVO memory service on startup, auto-updates changelog from version.json
2. **`src/router.js`** — new SYSTEM category with keyword detection for architecture/system queries
3. **`src/claude.js`** — SYSTEM category always fetches system memories + live status, routes to local model first
4. **`src/tools/handler.js`** — system_status enhanced with knowledge context

### Data Flow

```
User: "How does the voice pipeline work?"
  → Router: SYSTEM category (keyword match)
  → Fetch system memories from EVO (semantic search)
  → Fetch live status snapshot
  → Inject as context → local model (qwen3.5:35b)
  → Local model answers from provided knowledge
  → If empty/failed → Claude (already has architecture in prompt)
```

### Knowledge Entries (seeded on startup)

- Architecture overview (3 devices, roles)
- Voice pipeline (mic → Whisper → wake → route → Pi → TTS)
- WhatsApp pipeline (Baileys → classify → route → respond)
- Each component (Pi, EVO, Dashboard) with IPs, ports, services
- Model inventory (Claude, qwen3.5:35b, qwen3:0.6b, Whisper, Piper)
- Routing logic (complexity detection, keyword heuristics, classifier, fallback)
- Tool inventory (calendar, email, travel, todos, soul, memory, web search)
- Config summary (env vars, API keys used)
- Changelog (from version.json, updated each startup)

### Router SYSTEM Category

Keywords: system, architecture, pipeline, components, services, what's running, voice pipeline, dashboard, evo, ollama, whisper, deployment, what changed, changelog, version, how does X work

### Memory Injection

SYSTEM category added to MEMORY_CATEGORIES so memories are always fetched. System memories searched with query text, top 8 results injected as context for local or Claude model.

### Auto-Update

- On startup: seed/refresh all system knowledge entries
- On version change: add changelog entry
- Voice heartbeat: already tracked for live status
- No manual maintenance required
