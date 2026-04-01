# CLAUDE.md — Clawdbot (Clawd Monet)

> **READ THIS FIRST.** Every session must start by reading this file AND `architecture.md`. Do not skip.
> See also: [Data Flows](docs/data-flows.md) | [API Reference](docs/api-reference.md) | [Deployment](docs/deployment.md) | [EVO X2 Reference](docs/evo-x2-reference.md)

## Quick Reference

| Key | Value |
|-----|-------|
| **Pi IP** | `192.168.1.211` LAN / `100.104.92.87` Tailscale (`cnc`) |
| **Pi user** | `pi` (NOT `james`) |
| **EVO X2 IP** | `10.0.0.2` direct ethernet (prefer) / `192.168.1.230` WiFi / `100.90.66.54` Tailscale |
| **EVO user** | `james` (NOT `pi`) |
| **SSH key** | `C:\Users\James\.ssh\id_ed25519` |
| **Pi project path** | `~/clawdbot` (NOT `~/clawdbot-claude-code`) |
| **Local project path** | `C:\Users\James\Downloads\clawdbot-claude-code` |
| **Model (default)** | `MiniMax-M2.7` (Anthropic-compatible API) |
| **Model (premium)** | `claude-sonnet-4-6` (explicit request only) |
| **Node** | v20+, ESM, `node --env-file=.env src/index.js` |
| **Dashboard** | Rust native app `clawd-dashboard` (NOT Chromium) |
| **Pi display** | 10.1" touchscreen, 1024x600 |

For EVO services/ports/models, see [EVO X2 Reference](docs/evo-x2-reference.md).
For deploy commands and SSH patterns, see [Deployment](docs/deployment.md).

## Session Protocol — MANDATORY

1. **Read `CLAUDE.md` and `architecture.md`** at start of every session.
2. **Verify Pi IP** before deploying — ping `192.168.1.211` first.
3. **After deploying Node.js files**, restart: `sudo systemctl restart clawdbot`.
4. **Never use `-uall` flag** with `git status` (can OOM).

## Research Protocol — MANDATORY

- **ALWAYS search online** for hardware compatibility, driver support, library versions, benchmarks. Never rely on training data for version-specific info.
- EVO X2 runs AMD Ryzen AI MAX+ 395 with Radeon 8060S (gfx1151, RDNA 3.5). Training data will be stale.
- When researching models, cast a **wide net** — check current leaderboards, not just Qwen.

## Project Overview

WhatsApp admin assistant bot ("Clawd") on Raspberry Pi 5 with touchscreen dashboard. Personal assistant for James Cockburn: calendar, email, travel, todos, soul/personality system.

**Who uses it:** James (owner, full access) and MG (wife — calendar reading, todos, travel, web search only).

**Tech:** Node.js 20+ ESM, Baileys (WhatsApp), three-tier AI (local EVO free → MiniMax cheap → Claude premium), Rust dashboard, JSON file persistence. No database, no build step, no TypeScript.

## Design Decisions — BINDING

These are agreed decisions. Do not revisit, reverse, or work around them.

### Voice Pipeline
1. **Piper TTS for everything.** Orpheus-3B too slow. `speak()` delegates to `speak_fast()`.
2. **Every voice command MUST produce audible output.** No silent failures.
3. **Mic flush after ALL TTS.** Wait `audio_duration + 0.5s` before reopening mic.
4. **Follow-up mode after ALL spoken responses** (10s listening window).
5. **Local model handles everything the classifier routes locally.** Fix response layer, not routing.
6. **Wake phrase ack is "Yes?"** via Piper. Single-word only.
7. **Whisper initial_prompt must include wake phrases** and example commands.

### Architecture
8. **Bot code uses `evo-llm.js`** — OpenAI-compatible API. No legacy ollama.
9. **All EVO communication via direct ethernet** (`10.0.0.2`). Never WiFi for API calls.
10. **Dashboard is Rust/egui native app.** Not Chromium, not HTML.
11. **Fix general before specific.** Fix the class of bug, not the instance.

### Evolution Pipeline (DEPLOYED — 2026-03-25)
12. **Claude Code CLI on EVO** — v2.1.81, headless via `-p`. Git branches only, never main.
13. **Data collection layers complete**: interaction logging, reaction feedback, correction detection, dream diary.
14. **Local model does analysis only** — code mutation uses Claude Code CLI.

### Process Rules
15. **Update CLAUDE.md in real-time.** Every decision, immediately. Not at end of session.
16. **Use superpowers skills.** Brainstorming, systematic-debugging, verification — not optional.
17. **Fix general before specific** (repeated for emphasis).

### Group Chat & Social Intelligence
18. **Engagement classifier gates all group responses.** EVO 0.6B decides respond/silent. @mentions bypass.
19. **Mute system: 10 min per-group cooldown.** Only @mention breaks through. In-memory, resets on restart.
20. **All group messages logged** to JSONL. Feeds dream mode.

### Dream Mode & Memory
21. **Dream mode runs overnight on EVO.** Extractive only — no inference, no extrapolation.
22. **Dream summaries are long-term memory.** Progressive compression over 30 days.

### Soul & Self-Awareness
23. **Reactive soul proposals via DM.** Only James can approve personality changes.
24. **System self-awareness is queryable** via system-knowledge.json.
25. **Self-explanation is natural, not technical.** "I dream overnight" not architecture docs.
26. **Dream chaining.** Last 2-3 days' dreams as context. Today's conversations take priority.
27. **Group personality matches James.** Direct, compressed, sharp. No echoing, no filler.
28. **Soul is advisory, classifier is the gate.** Don't put response-gating in soul.
29. **Dream mode runs at 22:05.** All servers 24/7. Simple oneshot.
30. **Classifier fallback on EVO downtime.** Keyword heuristic: bot name + question mark.
31. **Memory service must be running for statefulness.** Port 5100, backbone of everything.
32. **Owner authority is absolute.** James overrides all learned behaviours.
33. **Intellectual backbone: adapt volume, never adapt accuracy.**
34. **Identity memories are immutable.** Category `identity` — never expired, never superseded.
35. **All EVO servers run 24/7.** No sleep/wake timers.

### LQuorum Working Memory
36. **Passive keyword scanning warms working memory.** 18 topics, pure keyword matching.
37. **Direct queries use `warmFromQuery()` with no length filter.**
38. **Working memory decays after 15 minutes.** Extended for high hitCount.

### Image & Document Handling
39. **EVO VL handles images locally.** Claude is fallback only. 5 min follow-up window.
40. **Documents summarised via EVO before Claude.** 85% token reduction.

### Web Search & Response Quality
41. **SearXNG for web search.** Free, self-hosted, no API key.
42. **Classifier silence via `[SILENT]` marker.** Filtered in index.js.
43. **max_tokens 4x** for substantive responses (4000 default).
44. **No emojis.** Global rule.
45. **Professional group filtering.** Personal categories blocked in professional groups.
46. **buildContext includes current message.**
47. **Startup message only on version change.**
48. **Google OAuth dead flag.** Stops retry spam on invalid_grant.

### Engagement & Response Quality (2026-03-24)
49. **BOT_NAMES excludes 'claude'.** Only `clawd|clawdbot` in engagement.js.
50. **LQuorum topics NOT injected into classifier.** Small model too easily influenced.
51. **Keywords run before complexity detection in router.**
52. **Message deduplication.** Last 200 message IDs tracked.
53. **Opus critique stripping uses --- divider.**
54. **Anti-slop writing rules in system prompt.**

### Dream Mode Housekeeping (2026-03-24)
55. **Dream orientation phase (Phase 0).** Fetches existing memories to prevent duplicates.
56. **Pre-store dedup + contradiction detection.** Similarity > 0.85 = skip.
57. **Stale memory pruning (Phase 5).** 30-day decay, protected categories exempt.
58. **Verbatim excerpt storage.** Exact quotes with 0.95 confidence.

### Evolution Pipeline (2026-03-25)
59. **Self-coding via Claude Code CLI on EVO.** All changes in git branches.
60. **evolution_task WhatsApp tool.** Owner-only, queued, max 3/day.
61. **DM approval required for all code changes.** No auto-deploy — ever.
62. **Deploy flow: merge → rsync → restart → health check.** Auto-revert on failure.
63. **Dream mode can create evolution tasks** via POST `/api/evolution/task`.
64. **Tailscale on all machines.** Pi `cnc`, EVO `james-nucbox-evo-x2`.

### Classifier & Group Behaviour (2026-03-25)
65. **Bot name in text → passive mode, not direct.** Only @mention/prefix is truly direct.
66. **2-minute response cooldown per group.** Only @mention breaks through.
67. **Classifier prompt is restrictive by default.**
68. **Self-coding keywords route to PLANNING.**
70. **Evolution tasks are triple-gated.** Code-level block + DM confirm ID + 10 min expiry.

### Overnight Report (2026-03-25)
69. **Overnight report sends .txt and .pdf attachments.**

### Evolution Hardening (2026-03-25)
71. **Two-pass evolution execution.** Manifest first, then scoped execution. Max 5 files, 150 lines.
72. **PreToolUse hook enforces scope on EVO.** `evo-hooks/scope-guard.sh`.
73. **Post-validation auto-rejects scope violations.**
74. **EVOLUTION.md replaces CLAUDE.md for Claude Code** on EVO. Prevents scope creep.
75. **Banned files list is code-level, not prompt-level.** Belt and suspenders.
76. **Overnight evolution: one fix per session.**

### MiniMax M2.7 Integration (2026-03-25)
77. **MiniMax M2.7 is the default cloud model.** ~8% of Claude's cost.
78. **Claude Opus 4.6 only on explicit request.** "ask claude", "use opus", etc.
79. **MiniMax replaces Opus in the quality gate.**
80. **Evolution pipeline uses MiniMax on EVO.** Claude as fallback.
81. **EVO local models for vision, doc summarisation, and classification ONLY.** No chat responses from local models.
82. **Two-tier chat strategy.** MiniMax M2.7 (all chat) → Claude Opus 4.6 (quality gate + explicit request). EVO is support layer (classify, see, summarise).

### Quality Gate & Opus Review (2026-03-26)
83. **Opus 4.6 is the quality gate** for PLANNING, LEGAL, long EMAIL (>400 chars, >200 chars).
84. **"Ask Claude" / "use opus" manual override works.**
85. **Opus post-review of overnight coding results.**

### Code Structure Rules (2026-03-26) — BINDING ON ALL AGENTS
86. **Maximum file size: 300 lines (JS) / 500 lines (Python).** Split before adding.
87. **One file, one job.** Single responsibility. If you need "and", split it.
88. **No duplicate functions.** Search before writing. Import, don't copy.
89. **All EVO communication goes through `evo-client.js`.** No direct HTTP to EVO.
90. **All constants in `constants.js` or `config.js`.** Zero `process.env` outside config.js.
91. **Errors are never silently swallowed.** Every catch logs or has an explaining comment.
92. **New scheduled tasks get their own file in `src/tasks/`.**
93. **Clean up after yourself.** Delete old files in the same commit.
94. **Refactoring is mandatory.** Fix violations when touching a file.

### Group Content Boundary (2026-03-26)
95. **ALL groups block personal admin.** Calendar, email, travel, todos — only available in DMs to James. `isProfessionalGroup()` returns true for any `@g.us` JID.
96. **In groups, Clawd acts as legal research assistant + AGI experiment.** Can discuss law, legal AI, own architecture, evolution, overnight learning. Cannot access any personal tools or memories.
97. **Memories, dreams, and insights are NOT blocked in groups.** They are part of Clawd's intelligence. Only personal admin tools (calendar, email, travel, todos) are blocked.

### Agentic Task Planner (2026-03-26)
98. **Task planner uses goal reasoning, not mechanical decomposition.** Two-phase: understand the goal first, then decompose into steps.
99. **Adaptive re-planning between steps.** Evaluates results after each step, skips redundant steps, adds new ones if gaps emerge.
100. **4B classifier is the PRIMARY routing layer.** Every message goes through 4B for category + needsPlan. Keywords are fallback only (EVO down). `mightNeedPlan()` and `detectComplexity()` removed.
101. **Task planner uses 30B model for reasoning.** `config.evoLlmUrl` (port 8080), not `config.evoPlannerUrl` (port 8085).

### Trace Analysis & Autonomous Improvement (2026-03-26)
102. **Trace analyser runs daily at 3 AM.** `src/tasks/trace-analyser.js`. Reads `data/reasoning-traces.jsonl`, outputs `data/trace-analysis.json`. Analyses routing, categories, models, plans, needsPlan accuracy, timing, anomalies.
103. **Weekly retrospective runs Sunday 4 AM.** `src/tasks/weekly-retrospective.js`. Uses EVO 30B to reason about top 3 improvement priorities from trace data. Auto-creates evolution tasks for high/medium severity.
104. **Trace diagnostics API endpoints.** `/api/traces` (latest nightly), `/api/traces/live` (on-demand 24h), `/api/retrospective` (latest weekly). All authenticated.
105. **Overnight report includes trace analysis and retrospective.** Sections added to `generateMarkdownReport()` in `overnight-report.js`.
106. **needsPlan probing in self-improvement cycle.** 23 synthetic test cases evaluate 4B classifier accuracy overnight. Results included in WhatsApp notification.

### Naming Conventions & Group Engagement (2026-03-27)
107. **`clawd`/`@clawd` = advisory/paralegal mode.** Full cognitive stack: 4B classification, needsPlan, task planner, quality gate. For complex analysis, legal research, multi-step requests.
108. **`clawdsec` = secretary/admin mode.** Skips task planner entirely (`needsPlan: false`). For single-tool admin: check calendar, add todo, search email. Fast path.
109. **Groups: @mention only.** No passive engagement. Bot name in text without @mention → silent. Reply-to-bot and prefix commands (`clawd ...`, `clawdsec ...`) also trigger. Future: autonomous participation with restraint.
110. **Passive mode removed from trigger.js.** Engagement classifier still exists but only fires for future autonomous mode. Current groups are @mention-gated.

### Per-Group Security Modes (2026-03-27)
111. **Three named modes control group disclosure.** `open` (no restrictions), `project` (blocks personal life/admin, side projects allowed), `colleague` (blocks personal life/admin AND all side projects). Architecture/capabilities always open.
112. **James sets modes by saying the phrase in the group.** "@clawd colleague mode" → Clawd calls `group_mode` tool. "@clawd project mode" / "@clawd open mode". Owner-only.
113. **Optional `blockedTopics` per group sit on top of the mode.** Set via DM: "block Shlomo in Tom's group" → `group_block` tool finds group by label, adds topic. Never said aloud in the group.
114. **Unregistered groups default to `colleague` mode.** Blocks personal admin, personal life, AND all side projects. Safe default.
115. **Three-layer defense: prompt + output filter + canary.** Prompt-level restrictions tell the model what not to say. `output-filter.js` scans every response with deterministic regex BEFORE sending — blocks personal life patterns (project+colleague modes) and side project names (colleague mode). Per-group blockedTopics always scanned. Canary token detects prompt leakage. Cannot be prompt-injected.
116. **Anti-prompt-injection hardening in group prompts.** Identity lock (always Clawd), instruction hierarchy (system overrides user), anti-extraction instruction, anti-role-play instruction. Injected for all groups.

### Group Analysis Modes (2026-03-28)
117. **Devil's advocate and summary modes are two-step.** Step 1: present topic list (from index + today's live messages). Step 2: user selects topics ("1 and 3" or "all"), Clawd executes critique or summary via Opus with tools.
118. **Trigger phrases.** Devil's advocate: "devil's advocate" (handles smart quotes). Summary: "summarise", "summary", "recap", "catch me up", "what did I miss".
119. **Pending action system.** In-memory Map with 5-minute expiry per group. Stores topics, transcript, historical/today split, and mode between steps. Cleared after execution or on timeout.
120. **Topic index built overnight on EVO 30B (free).** At 2 AM, alongside memory extraction, each group's day logs are clustered into topics and stored in `data/topic-index/<group>.jsonl`. 30-day pruning. On-demand requests merge historical index with today's live messages (clustered via EVO).
121. **Devil's advocate uses Nemeth/Klein framework.** Key assumptions (CIA), pre-mortem (Klein), steelman opposition, blind spots, constructive close. Grounded in evidence, not theatrical.
122. **Both modes use memory_search and web_search tools.** Accuracy and context from memories and web search. Execution uses Opus.
123. **Output filter applies to group mode responses.** Same three-layer defense as regular messages.
124. **Files: `topic-index.js` (overnight + retrieval), `topic-scan.js` (shared formatting/parsing), `pending-action.js`, `group-modes.js`.** Plus `getGroupModeResponse()` in `claude.js` and wiring in `message-handler.js`.

### Memory System Hardening (2026-03-28)
125. **Pre-store dedup at 0.92 cosine threshold.** Every memory is checked against existing embeddings before storing. Protected categories (identity) bypass. Batch dedup also at 0.92.
126. **Scheduled maintenance runs overnight at 2 AM.** After extraction, before topic indexing. Expires old memories and deduplicates in one pass.
127. **Memory categories must match between Pi and EVO.** All categories used in code (identity, dream, system, insight, document, document_chunk, document_index) registered in config.py with correct TTLs.
128. **Memory injection token budget: 3000 tokens (~12000 chars).** Truncates at section boundaries. Identity and relevance memories preserved; insights, lquorum, dreams truncated first.
129. **Embedding model: Qwen3-Embedding-8B (4096d).** Replaced nomic-embed-text (768d, 137M). +13 MTEB points. Uses `--pooling last`, `<|endoftext|>` EOS token, instruction-aware query prefix. Port 8083.
136. **BM25 + vector search via RRF.** Replaced simple keyword matching. BM25 provides TF-IDF with length normalisation. Reciprocal Rank Fusion merges BM25 and vector rankings.
130. **EVO memory service DATA_DIR is `~/clawdbot-memory/data`.** NOT `~/clawdbot-memory`. The repo config.py must match.

### Memory Frontal Lobe (2026-03-28)
131. **Memory scoring uses source weights.** system_knowledge × 1.25, conversation × 1.0, dream × 0.90. Authoritative sources win ties.
132. **Confidence decays for volatile categories only.** system (30d), schedule (7d), travel (14d), dream (45d), general-from-ephemeral-sources (60d). Stable categories (identity, preference, person, legal, insight) never decay — intelligent ageing, not dementia.
133. **Contradiction suppression at retrieval.** Cosine ≥ 0.75 between results = same topic. Lower-scoring entry dropped. Prevents conflicting memories both reaching the prompt.
134. **Frequency score removed from search.** Access count created feedback loops rewarding stale popular memories. Replaced by effective_confidence.
135. **Auto-supersession at store time.** New memories with 0.70–0.91 cosine similarity to existing same-category memories auto-supersede the older one. Protected categories exempt. Activates the dormant `supersedes` field.

### Aristotle Mode (2026-04-01)
137. **Aristotle mode is single-step, not two-step.** No topic selection. Grabs recent chat or quoted message, sends directly to Opus with 5-phase first principles framework. Adaptive depth (condensed vs full) decided by model.
138. **Anyone can trigger aristotle mode in groups.** Not owner-only. Trigger: "aristotle", "first principles". Works in DMs too.
139. **Quoted messages take priority as focal point.** If the trigger message quotes another message, that message is the deconstruction target. Otherwise, recent ~50 messages scanned for main thrust.

## Known Gotchas

- **Google Calendar all-day events use exclusive end dates.** Subtract 1 day for display.
- **Multiple scheduler starts**: Guard (`schedulerStarted`) prevents duplicates on reconnect.
- **Owner detection uses two formats**: `OWNER_JID` (phone) and `OWNER_LID` (linked ID).
- **Widget cache TTL is 5 minutes.** Scheduler reads cached data.
- **Todo tools are NOT owner-restricted** — MG should be able to use them.

## Adding New Design Decisions

When a decision is made during a session, **add it to Design Decisions immediately**. Number sequentially. This is how continuity works across sessions.
