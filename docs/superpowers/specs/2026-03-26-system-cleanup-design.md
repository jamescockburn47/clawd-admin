# System-Wide Cleanup & Structural Rework

**Date:** 2026-03-26
**Status:** Proposed
**Scope:** All JS (src/), all Python (evo-*/memory-service/pi-*/), systemd services, CLAUDE.md governance rules

## Context and Problem Statement

The clawdbot codebase grew organically over 3+ months of rapid feature additions — many by AI agents (overnight coder, evolution pipeline, manual Claude Code sessions). The architecture is sound at the macro level but has accumulated:

- God-files (index.js at 1356 lines, 5 more files over 600 lines)
- Duplicated logic (evoFetch in 2 files, checkEvoHealth with conflicting names, 3 copies of dream_mode.py)
- Hardcoded values scattered across files (IPs, ports, timeouts)
- Silent error swallowing (8+ instances of empty catch blocks)
- Dead code and stale files (Orpheus TTS running but unused, ollama_client.py misnomer)
- No structural rules preventing AI agents from recreating the same problems

GitClear's 2025 study of 211M lines found AI-assisted codebases see 48% more copy-paste code and a collapse in refactoring (25% to <10% of changes). This codebase matches that pattern.

## Decision Drivers

- Must retain ALL existing functionality — zero behaviour changes
- Must be deployable incrementally (not a big-bang rewrite)
- Must include governance rules that prevent future drift
- Must apply to both JS and Python codebases
- Must be executable by AI agents (overnight coder, evolution pipeline) without human guidance

## Considered Options

1. **Surgical cleanup** — Fix duplicates, extract worst god-functions, centralise HTTP client. ~15 files touched.
2. **Structural rework** — Redesign module boundaries, shared infrastructure layer, scheduler refactor. ~25 files.
3. **Full audit** — Option 2 plus test coverage, Python cleanup, systemd audit, governance rules, dead code removal.

## Decision Outcome

**Option 3: Full audit.** If we're opening the codebase up, leaving without test coverage and governance rules is false economy. The overnight coder already generates tests but needs a clean foundation.

---

## 1. Shared Infrastructure Layer

### 1.1 `src/evo-client.js` — Single HTTP Client for All EVO Communication

**Problem:** `evo-llm.js` and `memory.js` both define `evoFetch()` with identical timeout/abort patterns. Both export `checkEvoHealth()` — one checks port 8080, one checks 5100. Five files hardcode `10.0.0.2`.

**Design:**
- Single `evoFetch(path, options)` with configurable timeout, abort controller, and retry logic
- Named health checks: `checkLlamaHealth()`, `checkMemoryHealth()`, `checkClassifierHealth()`
- Circuit breakers for all three services (currently only Google/Claude/Weather have breakers)
- All URLs derived from `config.js` — zero hardcoded IPs anywhere else in the codebase

**Consumers:** `evo-llm.js`, `memory.js`, `system-knowledge.js`, `evolution-executor.js`, `claude.js`

### 1.2 `src/constants.js` — Centralised Magic Numbers

**Problem:** Timeouts, buffer sizes, cooldowns, and limits are scattered as inline numbers across 10+ files.

**Design:**
- Category enums (currently defined in router.js, referenced elsewhere)
- Timeout values (request timeouts, health check intervals, mute durations)
- Buffer sizes (message buffer length, max message length, verbatim window)
- Cooldown durations (group response cooldown, mute duration)
- Model names and service identifiers

`config.js` remains for env-var-driven values. `constants.js` is for fixed values that don't change between environments.

### 1.3 `src/config.js` — Tighten Existing Config

**Problem:** Some files access `process.env` directly instead of going through config.js. Evolution-executor.js hardcodes EVO paths.

**Design:**
- Add `EVO_MEMORY_URL`, `EVO_EMBED_URL`, `EVO_DOCLING_URL` to config
- Add `EVO_SSH_USER`, `EVO_REPO_PATH` for evolution executor
- Ensure zero `process.env` access outside config.js (except logger.js which needs it at import time)
- Freeze the exported config object (`Object.freeze()`)

---

## 2. JavaScript File Splits

### 2.1 `src/index.js` (1356 → ~200 lines)

Currently handles: WhatsApp socket, message parsing, document downloading, image handling, evolution approval, soul proposals, HTTP server, SSE, mute triggers, emotion detection, deduplication.

**Split into:**

| New File | Responsibility | Estimated Lines |
|----------|---------------|-----------------|
| `src/index.js` | App entry: create socket, wire handlers, start HTTP server and scheduler | ~150 |
| `src/message-handler.js` | Process incoming WhatsApp messages: extract text/media, classify, route to response generation, send reply | ~250 |
| `src/document-handler.js` | Download, parse (pdf-parse/mammoth), summarise via EVO, cache raw text | ~150 |
| `src/http-server.js` | Express-like HTTP server: dashboard API endpoints, SSE broadcaster, evolution approval endpoint | ~200 |
| `src/evolution-gate.js` | Evolution task approval/rejection via WhatsApp DM, confirmation tracking, timeout expiry | ~120 |

### 2.2 `src/memory.js` (726 → ~250 lines)

Currently handles: HTTP client to EVO, memory search/store, local cache, retry queue, conversation logging, document metadata, image analysis bridge, health monitoring.

**Split into:**

| New File | Responsibility | Estimated Lines |
|----------|---------------|-----------------|
| `src/memory.js` | Memory search, store, queue operations (uses evo-client.js for HTTP) | ~250 |
| `src/conversation-logger.js` | JSONL conversation logging per group, log rotation | ~100 |

Health monitoring moves to `evo-client.js`. Image analysis bridge stays in `evo-llm.js`.

### 2.3 `src/evo-llm.js` (485 → ~250 lines)

Currently handles: API client, tool schema conversion, system prompt building, vision analysis, document summarisation, working memory injection.

**After:** Remove duplicated HTTP client (use evo-client.js). Tool schema conversion stays here — it's LLM-specific. Vision and document summarisation stay here — they're LLM operations. ~250 lines.

### 2.4 `src/scheduler.js` (596 → ~100 lines)

Currently handles: 10+ unrelated tasks on a 60-second tick.

**Split into:**

| New File | Responsibility |
|----------|---------------|
| `src/scheduler.js` | Just the 60-second loop. Registers and calls task functions. ~100 lines. |
| `src/tasks/todo-reminders.js` | Check due todos, send WhatsApp reminders |
| `src/tasks/meeting-alerts.js` | Side gig meeting 30-min alerts |
| `src/tasks/daily-backup.js` | 3 AM data backup |
| `src/tasks/briefing.js` | Morning briefing dispatch |
| `src/tasks/system-refresh.js` | System knowledge refresh |
| `src/tasks/evolution-dispatch.js` | Pick up pending evolution tasks |
| `src/tasks/improvement-cycle.js` | Self-improvement cycle trigger |

Each task file exports a single async function. Scheduler imports and calls them.

### 2.5 `src/overnight-report.js` (727 → ~300 lines)

Split data collection from rendering. Report generation stays in one file but the PDF rendering (Chromium headless) becomes a utility function in a separate file if it exceeds 300 lines after cleanup.

### 2.6 `src/widgets.js` (613 → ~300 lines)

Extract SSE broadcasting to `http-server.js` (where it belongs — it's HTTP infrastructure). `widgets.js` exports a `getWidgetData()` function; `http-server.js` calls it and pushes to SSE clients. Widget data fetching and caching stays in widgets.js. Should drop to ~300 lines.

### 2.7 `src/claude.js` (579 → ~280 lines)

**Split into:**

| New File | Responsibility | Estimated Lines |
|----------|---------------|-----------------|
| `src/claude.js` | Core response generation: build prompt, call MiniMax/Claude, return text | ~280 |
| `src/quality-gate.js` | Opus 4.6 review logic: shouldCritique check, critique prompt, response rewrite | ~150 |
| `src/usage-tracker.js` | Pricing calculation, daily call counting, usage stats persistence | ~100 |

---

## 3. Python Cleanup

### 3.1 Delete Stale Duplicates

- Delete `./dream_mode.py` (root — stale copy, 588 lines)
- Delete `./evo-voice/dream_mode.py` (stale copy, 598 lines)
- Keep only `./evo-memory/dream_mode.py` (876 lines, current active version with Phase 5)
- Verify `dream-mode.service` on EVO points to `evo-memory/dream_mode.py`

### 3.2 Rename Misleading Files

- `memory-service/ollama_client.py` → `memory-service/llm_client.py` (talks to llama.cpp, not Ollama)
- Update all imports referencing the old name

### 3.3 Error Handling Standardisation

Apply across all Python files:
- Replace bare `except:` with `except Exception as e:` at minimum
- Replace `except Exception: continue` with `except Exception as e: logger.warning(f"...{e}")` then continue
- Add specific exception types where the failure mode is known (e.g., `requests.Timeout`, `json.JSONDecodeError`)

### 3.4 Hardcoded Values

- `overnight-coder.py`: Move `10.0.0.2`, port numbers, timeout values to constants at top of file (Python doesn't have a shared config.js — keep constants module-local but grouped at the top)
- `dream_mode.py`: Same treatment for URLs, thresholds
- `voice_listener.py`: Group all timeout constants at top

### 3.5 File Size

- `overnight-coder.py` (1258 lines): Split into `overnight_config.py` (constants, HTTP client), `overnight_tasks.py` (task implementations), `overnight_coder.py` (main loop, CLI, reporting). Target: no file over 500 lines (Python's higher tolerance per Pylint default of 1000, but 500 is more maintainable).
- `voice_listener.py` (918 lines): Split VAD, Whisper, and network streaming into separate modules.
- `dream_mode.py` (876 lines): Split phases into individual functions in separate file if cleanup doesn't bring it under 500.

---

## 4. Systemd Service Audit

### 4.1 Dependency Ordering

**Problem:** Some services use `Wants=` without `After=`, meaning the dependency may not be ready when the service starts.

**Fix:** Every `Wants=` gets a corresponding `After=`. Specifically:
- `llama-server-main.service` Wants classifier → add `After=llama-server-classifier.service`
- `dream-mode.service` Wants memory → verify `After=clawdbot-memory.service`

### 4.2 Dead Services

- Disable and remove `llama-sleep.timer` and `llama-wake.timer` from repo (already disabled, but files still exist)
- Verify Orpheus TTS service: if truly unused, stop it on EVO to reclaim GPU memory. Keep the service file but disable it.
- Clarify `evo-evolve.service` vs `overnight-coder.service` — determine which is active, delete the other

### 4.3 Naming Consistency

All services follow pattern: `clawdbot-<component>.service` for bot services, `llama-server-<model>.service` for LLM services, `llama-swap-<direction>.{service,timer,sh}` for swap operations.

### 4.4 Logging

Ensure all services have `StandardOutput=journal` and `StandardError=journal` (some may be missing).

---

## 5. Governance Rules (CLAUDE.md Additions)

These rules go into the Design Decisions section of CLAUDE.md and are binding on all agents.

### Code Structure Rules

**Rule 86: Maximum file size is 300 lines (JS) / 500 lines (Python).**
ESLint `max-lines` default is 300. If a file exceeds the limit, it must be split before adding more code. The overnight coder, evolution executor, and any manual session must check file size before writing. No exceptions without explicit discussion with James.

**Rule 87: One file, one job.**
Each file has a single responsibility describable in one sentence. If you need "and" to describe what a file does, it's doing too much. Check the file's doc comment — if it lists multiple responsibilities, split it.

**Rule 88: No duplicate functions.**
Before writing a helper function, search the codebase (`grep -r "function functionName"` or equivalent). If it exists, import it. If it nearly exists, extend it. Never copy-paste. The overnight coder and evolution pipeline must include a duplication check step.

**Rule 89: All EVO communication goes through `evo-client.js`.**
No file may construct its own HTTP requests to EVO. No file may hardcode an EVO IP or port. Everything goes through the shared client which reads from config.js.

**Rule 90: All constants in `constants.js` or `config.js`.**
Timeouts, ports, URLs, buffer sizes, cooldowns — if it's a number or string that could change, it lives in one of these two files. `config.js` for env-var-driven values, `constants.js` for fixed values. Zero `process.env` access outside `config.js`.

**Rule 91: Errors are never silently swallowed.**
Every `catch` block must either (a) log with `logger.warn()` or `logger.error()`, or (b) have a comment explaining why silence is intentional (e.g., "expected on first run"). Same for Python `except` blocks — no bare `except:`, always `except SpecificError as e:` with logging. Empty catch blocks are bugs.

**Rule 92: New scheduled tasks get their own file in `src/tasks/`.**
`scheduler.js` is just the loop. Adding a new scheduled task means creating a new file in `src/tasks/`, not editing scheduler.js.

**Rule 93: Clean up after yourself.**
When you move or replace a file, delete the old one in the same commit. When you rename a service, remove the old .service file. No stale copies. The evolution pipeline post-validation must check for orphaned files.

**Rule 94: Refactoring is mandatory, not optional.**
When touching a file that violates any of rules 86-93, fix the violation as part of your change — don't just add more code to a file that's already too long. This directly counters the measured 48% increase in copy-paste code in AI-assisted codebases (GitClear 2025).

### Agent-Specific Instructions

Add to EVOLUTION.md (the file Claude Code on EVO reads):

```
BEFORE WRITING ANY CODE:
1. Check the target file's line count. If it's over 250 lines, consider whether your change should go in a new file instead.
2. Search for existing functions that do what you need: grep -r "functionName" src/
3. Check constants.js and config.js for values you need — do not hardcode.
4. After writing, verify: no file you touched exceeds 300 lines. If it does, split it.
```

---

## 6. Test Coverage

### 6.1 Existing Tests (Keep)

6 test suites covering routing, guardrails, security, soul, travel, APIs. These stay.

### 6.2 New Integration Tests

| Test | What It Covers |
|------|---------------|
| `test/message-flow.test.js` | Message arrives → trigger → router → tools → response. Mock WhatsApp and EVO. |
| `test/evo-client.test.js` | Shared HTTP client: timeouts, circuit breakers, health checks, retry logic |
| `test/memory-integration.test.js` | Memory search/store/queue with mocked EVO endpoints |
| `test/scheduler.test.js` | Each task in `src/tasks/` runs independently, handles errors, doesn't block others |
| `test/evolution-gate.test.js` | Approval flow: DM sent, confirm/reject, timeout expiry, scope validation |

### 6.3 Python Tests

- `test_dream_mode.py` — Verify dream phases produce valid output with mocked LLM responses
- `test_overnight_coder.py` — Verify health check, timeout handling, incremental save

### 6.4 Approach

Tests are written AFTER the refactor, against the new module boundaries. The overnight coder's existing test generation (router-eval, unit-tests) continues to work against the new structure.

---

## 7. Dead Code Removal

| Item | Action |
|------|--------|
| `./dream_mode.py` (root) | Delete |
| `./evo-voice/dream_mode.py` | Delete |
| `./check_vad.py` (6 lines, stub) | Delete |
| `llama-sleep.timer` / `llama-wake.timer` | Delete from repo (already disabled on EVO) |
| `evo-evolve.service` (if duplicate of overnight-coder) | Delete after verification |
| Orpheus TTS service on EVO | Disable (`systemctl disable llama-server-tts`) to reclaim GPU memory; keep file in repo |
| `ollama_client.py` | Rename to `llm_client.py` |
| `dev-journal.jsonl` | Verify if used; delete if not |

---

## 8. Implementation Order

The refactor must be deployable incrementally. Each phase is independently deployable and testable.

Time estimates below assume AI-agent execution (Claude Code / parallel agents), not human coding time.

**Phase 1: Infrastructure** (~1 hour)
- Create `src/evo-client.js` and `src/constants.js`
- Update `config.js` with new EVO URLs
- Update consumers to use new shared client
- Deploy. Verify everything still works.

**Phase 2: Split index.js** (~2 hours)
- Extract `message-handler.js`, `document-handler.js`, `http-server.js`, `evolution-gate.js`
- `index.js` becomes thin orchestrator
- Deploy. Verify WhatsApp, dashboard, evolution approval all work.

**Phase 3: Split scheduler and memory** (~1 hour)
- Create `src/tasks/` directory with individual task files
- Split `memory.js` → `memory.js` + `conversation-logger.js`
- Extract SSE from widgets.js to http-server.js
- Deploy. Verify scheduled tasks, memory operations, SSE all work.

**Phase 4: Python cleanup** (~1 hour)
- Delete stale dream_mode.py copies
- Rename ollama_client.py
- Fix error handling across all Python files
- Group constants at top of each file
- Split overnight-coder.py if over 500 lines
- Deploy to EVO. Verify dream mode, overnight coder, memory service.

**Phase 5: Systemd audit** (~30 min)
- Fix dependency ordering (After= for every Wants=)
- Disable Orpheus TTS
- Remove dead timers
- Clarify evo-evolve vs overnight-coder

**Phase 6: Tests** (~2 hours)
- Write integration tests against new module boundaries
- Write Python tests for dream mode and overnight coder
- Run full eval suite to verify no regressions

**Phase 7: Governance** (~30 min)
- Add rules 86-94 to CLAUDE.md
- Update EVOLUTION.md with agent-specific instructions
- Update architecture.md to reflect new structure
- Deploy updated docs to Pi and EVO

---

## Verification

After each phase:
1. Deploy to Pi / EVO as appropriate
2. Restart clawdbot, verify `systemctl is-active`
3. Send a test WhatsApp message — verify response
4. Check dashboard loads at localhost:3000
5. Check EVO health: `curl http://10.0.0.2:8080/health`
6. Check memory service: `curl http://10.0.0.2:5100/health`
7. Run existing eval: `node eval/run-eval.js` — must maintain 94.9%+ baseline
8. Check logs for errors: `journalctl -u clawdbot -n 50 --no-pager`

After all phases:
- Manual overnight coder test (single task)
- Let it run overnight — check morning briefing
- Review git log for clean commit history
