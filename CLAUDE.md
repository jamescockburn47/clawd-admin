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

**Tech:** Node.js 20+ ESM, Baileys (WhatsApp), three-tier AI (local EVO free → MiniMax cheap → Claude premium), Rust dashboard, JSON file persistence. No database, no build step. JSDoc + @ts-check for type safety (no TypeScript compilation).

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
14. **Local model does analysis only** — code mutation uses Claude Code CLI.

### Process Rules
15. **Update CLAUDE.md in real-time.** Every decision, immediately. Not at end of session.
16. **Use superpowers skills.** Brainstorming, systematic-debugging, verification — not optional.

### Group Chat & Social Intelligence
18. **Groups are @mention/prefix only.** Old 0.6B engagement classifier retired. @mention, reply-to-bot, or prefix (`clawd ...`) required. See #109-110.
19. **Mute system: 10 min per-group cooldown.** Only @mention breaks through. In-memory, resets on restart.
20. **All group messages logged** to JSONL. Feeds dream mode.

### Dream Mode & Memory
21. **Dream mode runs overnight on EVO.** Extractive only — no inference, no extrapolation.
22. **Dream summaries are long-term memory.** Progressive compression over 30 days.

### Soul & Self-Awareness
23. **Reactive soul proposals via DM.** Only James can approve personality changes.
24. **System self-awareness is queryable** via `data/system-knowledge/` (modular sub-files, seeded into EVO memory nightly).
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
61. **DM approval required for all code changes.** No auto-deploy — ever.
62. **Deploy flow: merge → rsync → restart → health check.** Auto-revert on failure.
64. **Tailscale on all machines.** Pi `cnc`, EVO `james-nucbox-evo-x2`.

### Classifier & Group Behaviour (2026-03-25)
65. **Bot name in text → passive mode, not direct.** Only @mention/prefix is truly direct.
66. **2-minute response cooldown per group.** Only @mention breaks through.
67. **Classifier prompt is restrictive by default.**
68. **Self-coding keywords route to PLANNING.**

### Overnight Report (2026-03-25)
69. **Overnight report sends .txt and .pdf attachments.**

### Evolution Hardening (2026-03-25)
71. **Two-pass evolution execution.** Manifest first, then scoped execution. Max 5 files, 150 lines.
72. **PreToolUse hook enforces scope on EVO.** `evo-hooks/scope-guard.sh`.
73. **Post-validation auto-rejects scope violations.**
74. **EVOLUTION.md replaces CLAUDE.md for Claude Code** on EVO. Prevents scope creep.
75. **Banned files list is code-level, not prompt-level.** Belt and suspenders.

### MiniMax M2.7 Integration (2026-03-25)
77. **MiniMax M2.7 is the default cloud model.** ~8% of Claude's cost.
78. **Claude Opus 4.6 only on explicit request.** "ask claude", "use opus", etc.
79. **MiniMax replaces Opus in the quality gate.**
81. **EVO local models for vision, doc summarisation, and classification ONLY.** No chat responses from local models.
82. **Two-tier chat strategy.** MiniMax M2.7 (all chat) → Claude Opus 4.6 (quality gate + explicit request). EVO is support layer (classify, see, summarise).

### Quality Gate & Opus Review (2026-03-26)
83. **Opus 4.6 is the quality gate** for PLANNING, LEGAL, long EMAIL (>400 chars, >200 chars).
84. **"Ask Claude" / "use opus" manual override works.**
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

### Code Quality Standards (2026-04-03) — BINDING ON ALL AGENTS

**Architecture & Design**
172. **Classes for stateful services.** Router, memory client, LLM service, cortex, tool handler — these own state and belong in classes. Pure utility functions stay as functions. If it has module-level `let` variables, it should be a class.
173. **Manual dependency injection.** Classes receive dependencies via constructor params — never import singletons directly for services they depend on. No DI container (over-engineering for this codebase). Factory functions create configured instances. This is for testability, not ceremony.
174. **Single entrypoint per feature.** Each service class has one main public method orchestrating the workflow. Supporting logic in private methods or composed helpers. Outside code calls the entrypoint only.
175. **Dispatch over if/else chains.** Use Map/object lookup, polymorphism, or registry patterns for branching on type/value. Applies to router categories, tool dispatch, model selection.
176. **Repository pattern for I/O.** Business logic never touches files, APIs, or external services directly. All I/O through service classes passed as dependencies. Memory access through MemoryClient, LLM calls through LLMService, etc.

**Type Safety (Without TypeScript)**
177. **JSDoc + `@ts-check` on critical modules.** No TypeScript migration (no build step). Add `// @ts-check` and JSDoc type annotations to: tool handler, cortex, router, memory client, claude.js. VS Code catches type errors. The Forge gets type context for safer code generation.
178. **Pydantic at API boundaries only (Python).** Request/response validation on FastAPI endpoints. Dataclasses for internal structures. Pydantic adds 6.5x instantiation overhead — don't use it where it doesn't guard an external boundary.
179. **Enums for fixed values.** Status codes, categories, routing decisions, group modes — all frozen objects (JS) or Enums (Python). No raw strings for values with defined meanings.
180. **Full JSDoc annotation on public methods.** Every exported function and class method gets `@param`, `@returns`, and a one-line description. Code readable from signatures alone.

**Error Handling**
181. **No silent failures — strictly enforced.** Every catch block either: (a) handles with recovery logic, (b) logs with context (`logger.error({ err, query, context })`) and re-raises or returns error, or (c) has `// intentional: [reason]` comment. Bare `catch {}` is banned. Reinforces rule #91.
182. **Log errors with context, not exception types.** What failed, what the input was, why it matters. Context in the log beats custom exception hierarchies. A `catch (err) { logger.error('memory search failed', { query, err }) }` is more useful than `catch (err) { if (err instanceof MemorySearchError)... }`.
183. **No magic numbers or strings.** Every value with meaning gets a name — constant, enum, or config value. Hardcoded thresholds (cosine similarity, timeouts, budgets, BM25 params) belong in `constants.js` or `config.js`.

**Config & Resources**
184. **Config validation on startup.** Add runtime checks in `config.js` that fast-fail if critical env vars are missing or malformed. Python: validate in config.py at import time. Catch bad config before it causes a subtle runtime failure.
185. **Context managers for resources (Python).** HTTP sessions, file handles → `async with`. Wrap in dedicated classes. Node.js: explicit cleanup in `finally` blocks.

**Async & Performance**
186. **Concurrent operations where independent.** `Promise.all` (JS) / `asyncio.gather` (Python) for independent tasks. Never await sequentially when tasks don't depend on each other. Already practiced in cortex.js — extend everywhere.
187. **Semaphores require justification.** Before adding concurrency limiters, document what the bottleneck is, risk of unlimited concurrency, and recommended limit. No silent semaphores.

**Logging**
188. **Errors + diagnostics only.** Log errors with full context. Keep structured diagnostic logs that feed trace analysis (routing decisions, plan outcomes, timing). Remove routine info noise (startup confirmations, cache hits, per-request success). Every log line must be actionable or analytically useful.

**Testing**
189. **Unit tests for all new code.** Use `node:test` with `mock.fn()`/`mock.method()` for spies/stubs. Use `esmock` for ESM module mocking. No sinon needed. Python: pytest + pytest-mock. If hard to test → the design needs to change.
190. **JSDoc/docstrings on all methods.** One line: what it does and why. Type annotations handle the contract, docstring handles the intent.

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

### Overnight Pipeline Optimisation (2026-04-01)
140. **Dream diary is novelty-aware.** Yesterday's diary injected as comparison. Prompt: "focus on what's NEW or CHANGED." No padding thin days.
141. **Minimum 10 messages for full diary.** Groups below threshold get a one-liner ("Quiet day — N messages"). Prevents wasted LLM calls.
142. **Dynamic diary token budget.** `min(1200, max(300, msg_count * 15))`. Thin days = short diaries. Busy days = full depth.
143. **Insights must be evidence-grounded.** Each insight must cite at least 2 specific messages by timestamp and sender. Ungrounded speculation = "none".
144. **Evolution pipeline section in overnight report.** Shows deployed, awaiting approval, failed, rejected, queued tasks with details. Rate limit status.
145. **Self-improvement results are human-readable.** Bullet-point format (iterations, rules proposed/validated/applied, categories), not JSON blobs.
146. **Diary quality metrics in report.** Per-group: facts new/deduped/superseded, insights new/skipped. Header shows aggregate signal-to-noise ratio.

### Evolution Pipeline Bridge (2026-04-02)
146b. **overnight-to-evolution.js bridges overnight analysis to tasks.** Runs at 5 AM. Reads code-quality.json, trace-analysis.json, and overnight briefing. Converts high/medium findings to evolution tasks. Max 2 tasks per night.
147. **Retrospective runs DAILY at 4 AM (bootstrap period).** Was Sunday-only. Creates evolution tasks from trace analysis priorities. Revert to Sunday-only once pipeline is healthy and producing tasks.
148. **Live Monitor shows ALL messages, not just bot.** `/api/messages` returns merged feed from all chat buffers via `getAllRecentMessages()`. Messages annotated with `chatJid` and `isBot`.
149. **Memory cards show 6 lines before truncation.** `line-clamp-6` instead of `line-clamp-3`. Expand button says "More"/"Less".

### The Forge — Autonomous Recursive Self-Improvement (2026-04-03)
150. **The Forge replaces all overnight coding.** overnight-coder.py, evo-evolve, self-improve cycle, weekly-retrospective all replaced by forge-orchestrator.js.
151. **Skills are the primary output.** New capabilities as `src/skills/` modules, not bug fixes. Skill contract: name, canHandle(), execute(), selfExplanation.
152. **Skill registry auto-discovers.** `src/skill-registry.js` scans `src/skills/*.js` at startup. No manual registration.
153. **Skills are post-processing hooks.** Inserted after getClawdResponse(), before filterResponse(). Augment, never replace.
154. **Opus via Max subscription for all Forge coding.** Free on Max plan. No MiniMax for evolution.
155. **Staged autonomy.** New skills auto-deploy (additive, sandboxed). Existing file modifications need approval.
156. **Three-gate validation.** Architect classifies + tests pass + reviewer validates. All three for auto-deploy.
157. **DGM evolutionary gate.** Changes must be improvements, not just correct.
158. **Recursive meta-improvement.** Forge improves its own prompts in `data/forge/prompts/`.
159. **Self-knowledge is live.** Capabilities queried from skill registry, not static JSON.
160. **Orchestrator is human-only.** `forge-orchestrator.js` cannot be modified by the Forge.

### Cortex — Parallel Intelligence Fan-Out (2026-04-03)
161. **Cortex replaces sequential classify→memory pipeline.** `src/cortex.js` fires classification, relevant memories, identity, dreams, insights, lquorum, and speculative web prefetch all concurrently via `Promise.all`. Shaves 1-3s off every response.
162. **Speculative web prefetch on heuristic match.** If the message matches `WEB_HINT_PATTERN` (search/latest/current/news/etc.), SearXNG fires in parallel with classification. Results cached 60s. Tool executor checks cache before hitting SearXNG again.
163. **Web prefetch is cache-only, never injected into prompt.** Prefetch results sit in a Map. Only used when the LLM explicitly calls `web_search` via tool use. No extra tokens, no cost increase.
164. **Category-based late prefetch.** If heuristic didn't fire but classifier returns GENERAL_KNOWLEDGE or PLANNING, a fire-and-forget SearXNG call is launched. May land in time for the tool loop.
165. **Each cortex stream fails independently.** Memory down? Identity still works. SearXNG timeout? Classification still returns. No single failure blocks the pipeline.

### Overnight Pipeline Reorder (2026-04-03)
170. **Forge moved to 04:30 (was 22:30).** Runs LAST so it consumes all prior overnight outputs: dream diary (22:05), Deep Think (23:00), self-improve (01:00), extraction (02:00), trace analysis (03:00), ground truth (03:30), retrospective (04:00 Sun). Phase 1 intelligence now reads trace-analysis.json, self-improve-log.jsonl, ground-truth.json, and weekly-retrospective.json.
171. **Ground truth harvester at 03:30.** `src/tasks/ground-truth.js`. Extracts verifiable factual claims from yesterday's traces, searches authoritative sources (legislation.gov.uk, BAILII, gov.uk), stores verified fact→source pairs in `data/ground-truth.json`. Max 10 claims per night, 500 entry cap. Conservative: only marks verified if authoritative source confirms key terms.

### Memory Search Tuning (2026-04-03)
166. **RRF rebalanced: `rrf * 12.0 + 0.25 * recency + 0.30 * eff_conf`.** Was `30.0 / 0.10 / 0.20`. Frontal lobe signals (recency, confidence, source weight) now meaningfully influence top-10 results.
167. **Contradiction suppression threshold raised to 0.83.** Was 0.75. Prevents suppressing related-but-distinct short facts.
168. **BM25 tags tokenised through `_tokenise()`.** Compound tags like `ai_consultancy` now split into `["ai", "consultancy"]` to match query tokens.
169. **Embedding calls batched in llm_client.py.** Up to 10 texts per request instead of one-at-a-time. `/reembed` is ~10x faster.

## Known Gotchas

- **Google Calendar all-day events use exclusive end dates.** Subtract 1 day for display.
- **Multiple scheduler starts**: Guard (`schedulerStarted`) prevents duplicates on reconnect.
- **Owner detection uses two formats**: `OWNER_JID` (phone) and `OWNER_LID` (linked ID).
- **Widget cache TTL is 5 minutes.** Scheduler reads cached data.
- **Todo tools are NOT owner-restricted** — MG should be able to use them.

## Adding New Design Decisions

When a decision is made during a session, **add it to Design Decisions immediately**. Number sequentially. This is how continuity works across sessions.
