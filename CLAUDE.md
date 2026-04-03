# CLAUDE.md — Clawdbot (Clawd Monet)

> **READ THIS FIRST.** Every session must start by reading this file AND `architecture.md`. Do not skip.
> See also: [Data Flows](docs/data-flows.md) | [API Reference](docs/api-reference.md) | [Deployment](docs/deployment.md) | [EVO X2 Reference](docs/evo-x2-reference.md)
> Archived/superseded decisions: [docs/archived-decisions.md](docs/archived-decisions.md)

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
| **Node** | v20+, ESM (migrating to TypeScript with `tsx`), `node --env-file=.env src/index.js` |
| **Dashboard** | Rust native app `clawd-dashboard` (NOT Chromium), 10.1" touchscreen 1024x600 |

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

**Tech:** Node.js 20+ ESM (migrating to TypeScript file-by-file, `tsx` runner), Baileys (WhatsApp), three-tier AI (local EVO free → MiniMax cheap → Claude premium), Rust dashboard, JSON file persistence. No database.

## Architectural Invariants — BINDING

These are constraints the agent cannot infer from code. Do not revisit, reverse, or work around them.

### Hardware & Network
- **All EVO communication via direct ethernet** (`10.0.0.2`). Never WiFi for API calls.
- **All EVO HTTP goes through `evo-client.js`.** No direct HTTP to EVO from other modules.
- **Dashboard is Rust/egui native app.** Not Chromium, not HTML.
- **Tailscale on all machines.** Pi `cnc`, EVO `james-nucbox-evo-x2`.
- **All EVO servers run 24/7.** No sleep/wake timers.

### Model Routing
- **MiniMax M2.7 is the default cloud model.** ~8% of Claude's cost. All chat responses.
- **Claude Opus 4.6 only on explicit request** ("ask claude", "use opus") or as quality gate for PLANNING, LEGAL, long EMAIL.
- **EVO local models for vision, doc summarisation, and classification ONLY.** Never generate chat responses.
- **4B classifier is the PRIMARY routing layer.** Keywords are fallback only (EVO down).

### Voice Pipeline
- **Piper TTS for everything.** Every voice command MUST produce audible output.
- **Mic flush after ALL TTS.** Wait `audio_duration + 0.5s` before reopening mic.
- **Follow-up mode after ALL spoken responses** (10s listening window).
- **Wake phrase ack is "Yes?"** via Piper. Single-word only.

### Group Behaviour
- **Groups are @mention/prefix only.** No passive engagement. `clawd ...` or `@clawd` for advisory mode, `clawdsec` for secretary/admin mode (skips planner).
- **Three security modes: open, project, colleague.** Unregistered groups default to colleague (most restrictive). James sets modes in-group.
- **Three-layer defense: prompt + output filter + canary.** Cannot be prompt-injected. Output filter is deterministic regex.
- **Anti-prompt-injection hardening.** Identity lock, instruction hierarchy, anti-extraction, anti-role-play.
- **ALL groups block personal admin tools.** Calendar, email, travel, todos — DMs to James only. Memories/dreams/insights are NOT blocked.
- **No emojis.** Global rule.

### Dream Mode & Soul
- **Dream mode runs overnight on EVO (22:05).** Extractive only — no inference, no extrapolation.
- **Insights must be evidence-grounded.** Each must cite 2+ specific messages.
- **Owner authority is absolute.** James overrides all learned behaviours.
- **Identity memories are immutable.** Never expired, never superseded.
- **Intellectual backbone: adapt volume, never adapt accuracy.**
- **Soul proposals via DM only.** Only James can approve personality changes.
- **Confidence decays for volatile categories only.** Stable categories (identity, preference, person, legal, insight) never decay.

### Evolution & The Forge
- **DM approval required for all code changes.** No auto-deploy — ever.
- **Deploy flow: merge → rsync → restart → health check.** Auto-revert on failure.
- **The Forge replaces all overnight coding.** Skills are the primary output (`src/skills/`). Opus via Max subscription.
- **Staged autonomy.** New skills auto-deploy (additive, sandboxed). Existing file modifications need approval.
- **Three-gate validation.** Architect + tests + reviewer. All three for auto-deploy.
- **Orchestrator is human-only.** `forge-orchestrator.js` cannot be modified by the Forge.
- **Evolution scope limits.** Max 5 files, 150 lines. Manifest first, scoped execution. Banned files list is code-level.
- **Forge runs at 04:30** (last, after all overnight outputs).

### Task Planner
- **Goal reasoning, not mechanical decomposition.** Understand the goal first, then decompose.
- **Adaptive re-planning between steps.** Skip redundant, add new if gaps emerge.

### Group Analysis
- **Devil's advocate uses Nemeth/Klein framework.** CIA assumptions, Klein pre-mortem, steelman opposition.
- **Aristotle mode is single-step.** Quoted messages take priority as focal point. Anyone can trigger.
- **Output filter applies to all group mode responses.**

## Code Standards — BINDING ON ALL AGENTS

### Structure Rules
- **Maximum file size: 300 lines (JS/TS) / 500 lines (Python).** Split before adding.
- **One file, one job.** Single responsibility.
- **No duplicate functions.** Search before writing. Import, don't copy.
- **All constants in `constants.ts` or `config.ts`.** Zero `process.env` outside config.
- **New scheduled tasks get their own file in `src/tasks/`.**
- **Clean up after yourself.** Delete old files in the same commit.
- **Refactoring is mandatory.** Fix violations when touching a file.
- **Fix general before specific.** Fix the class of bug, not the instance.

### Architecture & Design
- **Classes for stateful services.** If it has module-level `let` variables, it should be a class. Pure utility functions stay as functions.
- **Manual dependency injection.** Constructor params, not imported singletons. No DI container. Factory functions create configured instances.
- **Single entrypoint per feature.** One main public method per service class.
- **Dispatch over if/else chains.** Map/object lookup, polymorphism, or registry patterns.
- **Repository pattern for I/O.** Business logic never touches files/APIs directly.

### Type Safety
- **TypeScript for all new and touched files.** Rename `.js` → `.ts` when refactoring. Use `tsx` for execution. Strict mode, no `any`. This is an AI-coded project — types are the spec the AI reads before generating.
- **Pydantic at API boundaries only (Python).** Dataclasses internally. Pydantic adds 6.5x overhead.
- **Enums for fixed values.** Frozen objects (JS) or Enums (Python). No raw strings for defined meanings.

### Error Handling
- **No silent failures — strictly enforced.** Every catch: (a) handles with recovery, (b) logs with context and re-raises, or (c) has `// intentional: [reason]` comment. Bare `catch {}` is banned.
- **Log errors with context, not exception types.** What failed, what the input was, why it matters.
- **No magic numbers or strings.** Every meaningful value gets a name in constants/config.
- **Config validation on startup.** Fast-fail if critical env vars are missing or malformed.

### Async, Logging & Testing
- **Concurrent operations where independent.** `Promise.all` / `asyncio.gather`. Never await sequentially when tasks don't depend on each other.
- **Errors + diagnostics only.** Log errors with context. Keep structured diagnostics for trace analysis. Remove routine info noise.
- **Unit tests for all new code.** `node:test` with `mock.fn()`/`mock.method()` + `esmock` for ESM module mocking. Python: pytest + pytest-mock.
- **Docstrings/JSDoc on all public methods.** One line: what and why.

## Process Rules

- **Update CLAUDE.md in real-time.** Every decision, immediately. Not at end of session.
- **Use superpowers skills.** Brainstorming, systematic-debugging, verification — not optional.
- **Memory categories must match between Pi and EVO.** All categories in code registered in config.py with correct TTLs.
- **System self-awareness** lives in `data/system-knowledge/` (modular sub-files, seeded into EVO memory nightly).

## Known Gotchas

- **Google Calendar all-day events use exclusive end dates.** Subtract 1 day for display.
- **Multiple scheduler starts**: Guard (`schedulerStarted`) prevents duplicates on reconnect.
- **Owner detection uses two formats**: `OWNER_JID` (phone) and `OWNER_LID` (linked ID).
- **Widget cache TTL is 5 minutes.** Scheduler reads cached data.
- **Todo tools are NOT owner-restricted** — MG should be able to use them.
- **Google OAuth dead flag** in config stops retry spam on invalid_grant.

## Adding New Design Decisions

When a decision is made during a session, **add it to the relevant section above**. Implementation details that live in code should NOT be added here — only non-inferable constraints and invariants. See [docs/archived-decisions.md](docs/archived-decisions.md) for historical decisions.
