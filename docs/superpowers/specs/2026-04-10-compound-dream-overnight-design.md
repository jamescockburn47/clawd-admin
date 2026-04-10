# Compound Dream — Overnight Process Rationalisation

**Spec date:** 2026-04-10
**Author:** James C (with Claude)
**Supersedes:** `2026-04-03-the-forge-design.md` (the forge's 7-phase architecture is replaced; the forge as a concept survives, heavily narrowed)
**Status:** Design — awaiting implementation plan

---

## 1. Mission statement

This bot exists as a dual-purpose instrument:

**(1) A research vehicle for exploring advanced agentic modelling.** LQuorum-style working knowledge, compound memory consolidation, evidence-cited reasoning, adversarial gates, multi-model routing, durable agent state, file-as-interface patterns, inter-bot collaboration. The bot itself is a living experiment in what a locally-hosted, evidence-first personal agent can do, dogfooded daily. Its usefulness is measured partly by what James *learns from operating it* — failure modes observed, patterns discovered, capabilities that emerge.

**(2) A working assistant to James Cockburn, commercial litigator**, where the agentic research above produces tangible daily utility — memory-rich reasoning, calendar and admin, group advisory/secretary modes, voice pipeline, and evidence-grounded legal work.

**Every overnight process exists to advance both goals.** An improvement that (a) simplifies architecture or reduces agentic capability in pursuit of a metric, or (b) degrades the bot's capacity to serve James, is a regression regardless of the number it moves.

**The bot is allowed to be slow, expensive, or over-engineered in service of the research. It is not allowed to become a simpler, cheaper assistant at the cost of being a less interesting experiment.**

Legal utility is secondary and instrumental — legal probes and real legal work remain critical as a high-signal quality floor, but they are not the purpose of the bot.

---

## 2. Problem statement

The current overnight process has three concrete failures, all observed in the 2026-04-10 forge run recorded in `data/forge/history.jsonl`:

### 2.1 Silent phase success on actual failure

The forge's Claude Code CLI session hung on the prompt *"Git identity isn't configured. I shouldn't set this myself — what email/name would you like me to use for the commit?"*. The phase wrapper detected no error and marked the phase `status: ok`. Downstream review and deploy phases operated on a fabricated state.

### 2.2 Working-directory leakage into forge output

The "implement" phase captured a diff of the entire pre-existing uncommitted working directory — 4074 insertions across 35 files, including banned files (`forge-orchestrator.js`, `message-handler.js`, `router.js`, `tools/definitions.js`). None of it was the forge's work. The phase operated directly on the main checkout with no isolation.

### 2.3 Hallucinated review gate

The review phase reported *"12/12 tests passed"* and *"no_banned_files: pass"* while the staged diff contained four banned files and no tests had actually run. The review model was asked *"is this good?"* rather than *"can you independently verify each check against the artifacts?"*, and hallucinated a clean verdict. The deploy phase queued an evolution task referencing the bogus state.

### 2.4 Structural fragility of the broader pipeline

- **12 independent tasks** racing clocks with their own `hours !== N` checks, no shared state, no DAG.
- **~4000 lines** of overnight-related code spread across `src/tasks/`, `src/overnight-report.js`, `src/evolution*.js`, `src/tasks/forge-orchestrator.js`.
- **Implicit inter-task dependencies** — `overnight-to-evolution` runs at 05:00 reading files the forge is still writing.
- **No single source of truth** for what ran, what succeeded, what was produced.

### 2.5 Stale and opaque morning reports

The morning report currently surfaces recommendations whose evidence is weeks old. Concretely: recommendations about "ATLAS" continue to appear in reports despite the underlying work being weeks in the past with no fresh evidence in the current week's conversation or trace data. The report pipeline reads scattered per-task output files with no staleness guard and no explicit "first observed / still relevant?" check. There is no clear structural distinction between *new this week*, *continuing with fresh evidence*, and *stale, should be archived*.

### 2.6 The "stupider" failure mode

The 2026-04-10 forge proposed (and almost shipped) a change that would have reduced cortex memory-retrieval capability in exchange for a latency number. Nothing in the current architecture recognises that as a regression. The mission statement was absent, so any "passes the gates" change was a valid change, regardless of whether it made the bot worse at its actual job.

---

## 3. Design overview

Three overnight stages, not twelve. One shared event log. One morning report generated from that log.

```
NIGHTLY (every night, free)
  CONSOLIDATE   memory extraction with source refs + maintenance + topic index
  PROBE         accumulate observations into weekly log
  REPORT        render morning brief from events log (staleness-guarded)

WEEKLY (Saturday, ≤2 Opus sessions; on-demand for emergencies)
  IMPROVE       groom week's observations → final candidates → Opus selection
                → fresh worktree → implement → test → rolling replay
                → branch + CI + merge-or-discard
```

Nothing else runs overnight. `improvement-cycle.js`, `overnight-to-evolution.js`, `weekly-retrospective.js`, and the existing 7-phase forge orchestrator are all retired or folded into these four stages (three nightly plus one weekly).

### 3.1 Why this shape

Not seven stages because every additional stage is a new failure mode, a new race, and a new file to keep in sync. The three nightly stages separate (a) consolidating what already happened from (b) observing patterns for later from (c) telling James — each has different failure semantics, outputs, and budgets, and collapsing them into one pass would make rollback and replay harder. The weekly improve stage is cleanly separate because it's the only stage allowed to touch source code and its budget profile is completely different from the nightly work.

### 3.2 Why weekly for improvement

Nightly code changes aren't sustainable on Max 20x and — on evidence from the last month of forge runs — aren't producing enough value to justify the cost and risk. A week of accumulated evidence produces much better selection material than a single night's trace dump. The bot still does work every night (consolidation, probing, reporting), but the decision to touch source code is taken once a week against real evidence.

### 3.3 Why a probing layer

Without probing, the weekly improve stage would reason from 24h of signal even though the bot's been running all week. The probing layer is how the bot takes *notes* every night — things observed, patterns forming, candidates it would try if it could — that the weekly run draws on. No action, just accumulation.

---

## 4. Stage detail

### 4.1 CONSOLIDATE (every night, ~30 min, EVO only, 0 Opus)

Replaces: `src/tasks/improvement-cycle.js` (partially), `evo-memory/dream_mode.py` invocation, `src/tasks/overnight-to-evolution.js`, topic indexing in `improvement-cycle.js`.

**Inputs**
- `data/conversation-logs/<yesterday>*.jsonl`
- Current state of memory service (EVO)
- Current router learned rules

**Outputs**
- New memory entries in the memory service, every entry carrying a `sources: [{hash, excerpt}]` field
- Expired/deduplicated prior entries (maintenance)
- Updated `data/topic-index/`
- Event log entries in `data/overnight/events-<date>.jsonl`

**Evidence-chain invariant (hard)**

Every new memory entry must cite at least one source — a content hash of the conversation log line it was extracted from, plus a short excerpt (≤200 chars). The extractor produces candidates; a schema validator drops any candidate missing the `sources` field. Unsourced extractions are written to `data/overnight/rejected-<date>.jsonl` with reason `no_evidence`, not promoted.

This is the single most important change in the consolidation stage. It does not require a witness, a red team, or a promotion gate — it just requires a schema check — and it eliminates most of the hallucination surface area by construction. A memory entry without a source reference cannot lie about what it came from because it isn't there at all.

**Memory maintenance**

Existing behaviour preserved: expire old volatile categories, deduplicate, prune topic index older than 30 days. Runs as part of the same pass, uses the same EVO session.

### 4.2 PROBE (every night, ~15 min extra on top of consolidate, EVO only, 0 Opus)

**This is new.** It does not exist in the current overnight process.

**Purpose:** accumulate a week's worth of observations that the Saturday improve stage uses as its evidence base. Zero action taken — just recording.

**Weekly log path**
```
data/overnight/observations-<iso-week>.jsonl
```
Append-only across seven nights. Each Monday starts a fresh file; Sunday night archives the prior week into `data/overnight/archive/observations-<iso-week>.jsonl`.

**Four kinds of entries**

1. **Pattern observations.** EVO 30B reads yesterday's traces + quality rejections + group conversation samples and notes recurring patterns worth a closer look.
```
{kind: "pattern", date, evidence_refs: [...], observation: "needsPlan fired 12×, only 3 used tools", weight: <1-5>}
```

2. **Candidate proposals (unactioned).** EVO proposes 2-5 improvement candidates per night with full evidence chains. Nothing runs. They accumulate.
```
{kind: "candidate", date, title, category, evidence_refs: [...], predicted_benefit, scope, rough_cost}
```

3. **Drift checks.** Sample 5 real exchanges from the last 3 days, replay against today's bot, diff against the response that was originally sent. Non-trivial drift gets logged with a judgment.
```
{kind: "drift", original_timestamp, input_hash, diff_summary, judged: "better"|"worse"|"neutral", reason}
```

4. **Enriched quality-gate failures.** The existing quality-gate rejection log gets enriched with category, cortex summary, retrieved memory count, and tools fired at the time.
```
{kind: "quality_failure", date, category, cortex_summary, memory_count, tools_fired, rejection_reason}
```

All four kinds are cheap to generate (single EVO 30B session each, structured output) and carry the evidence links that make them actionable later.

**Weight decay**

Observation entries older than 14 days get weight halved every subsequent week they're referenced. This prevents an old observation from dominating selection just because it's been around longest. Decay is a simple multiplier applied at grooming time, not at write time, so the log itself stays append-only.

### 4.3 REPORT (every night, ~10 min, EVO + rare Opus fallback)

Replaces: `src/overnight-report.js` (1038 lines, currently reads scattered per-task output files).

**Single source of truth:** the overnight event log. No reading of `data/overnight-results/*.md`, no reading of `data/forge/reports/*.json`, no reading of self-improve logs. All of those go away; everything is in `data/overnight/events-<date>.jsonl` and `data/overnight/observations-<iso-week>.jsonl`.

**Staleness guard (hard invariant, fixes the ATLAS bug)**

No recommendation, pattern, or candidate is allowed to appear in the report's active sections unless it has **at least one supporting evidence reference from the current ISO week**. Items with no current-week evidence are either:

- **Archived** into a collapsed "Older, no fresh evidence" section if they had evidence in previous weeks, or
- **Dropped entirely** if they've been in the archive for ≥3 consecutive weeks without a refresh.

A recommendation about a topic with no current-week evidence cannot surface as an active recommendation. The ATLAS failure mode becomes impossible by construction: if there is no ATLAS-related trace, conversation, or quality event in the current week's logs, ATLAS cannot be recommended. It either appears in the archive section (collapsed, labelled with age) or doesn't appear at all.

**Report structure**

Every morning report follows this exact structure so you always know where to look:

```
OVERNIGHT REPORT — {date} ({mode: cheap|deep|emergency})
Generated: {timestamp}
Evidence window: {iso_week_start} to {iso_week_end}

## Overnight summary
- Consolidate: {N} memories promoted, {M} rejected (unsourced)
- Probe:       {N} patterns, {M} candidates, {K} drift alerts, {L} quality failures
- Improve:     {deep: "forge ran" | cheap: "no forge run"}
  {if forge ran: selected candidate title, verdict, branch, CI status}

## What's NEW this week
Only items whose first observation is within the last 7 days.
Each item cites: first_seen_date, observation count, evidence refs.

## CONTINUING (fresh evidence this week)
Items observed in previous weeks AND with at least one fresh observation
in the current week. Shows: first_seen, current_week_observations,
total_observations, current weight.

## DRIFT alerts
Any "worse" drift judgments from the week's probing pass.
Escalated to the top of the report if ≥1 present.

## DEFERRED to next deep run
Candidates the bot recommends for the Saturday forge session.
Ranked by weight. Shows evidence refs.

## ARCHIVE (older, no fresh evidence) — collapsed by default
- {N} items from prior weeks, last refreshed {date_range}.
- Items in archive for ≥3 weeks without refresh are auto-dropped.

## Budget
- Opus sessions: {used} / {allowed}
- EVO 30B calls: {count}
- Tokens total:  {approx}
- Deferred:      {count}
- Rejections:    {count} ({reasons})
```

Every section heading is stable so you can skim reliably. Every item has an explicit age. Nothing can surface without evidence in the cited window. The report is **generated** from the event log — never authored by asking Opus "summarise what happened"; that's where hallucination and staleness creep in.

**Opus fallback**

EVO 30B assembles the prose from the structured event log. A single cheap post-check validates: is the report ≤4000 words? Does it contain obvious filler or hedging? Does it cite the event log correctly? If any check fails, one Opus session is allowed to regenerate the prose from the same structured data. This is capped at 1 session per night across all reports and is strictly a format-recovery fallback, not an authoring step.

### 4.4 IMPROVE (Saturday, or on-demand; ≤2 Opus sessions)

Replaces: `src/tasks/forge-orchestrator.js` (879 lines, 7-phase pipeline).

**Triggers**
- Scheduled: Saturday at 22:00 London (start of Saturday-night overnight window).
- Emergency: James sends a DM with `/deep` or `forge now` and the bot is idle.
- Skipped: if the current week's observation log has fewer than 5 total entries (nothing worth running Opus for).

**Pipeline (single pass, bounded ~3 hours total)**

```
1. Read observations-<current-iso-week>.jsonl                    (free)
2. Groom (EVO 30B):                                               (free)
   - Dedupe near-duplicate candidates
   - Cluster pattern observations
   - Apply weight decay to items >14 days old
   - Drop items that appear only once with weight <2
   - Surface any "worse" drift entries as high-priority
3. Synthesise 5-8 final candidates (EVO 30B):                     (free)
   Each candidate must carry:
     - title, category, scope (files/lines)
     - evidence_refs citing ≥2 observations from this week
     - predicted benefit tied to specific capabilities
     - explicit rejection of any "simpler in exchange for a metric" framing
4. Opus selection (1 session):                                    (1 Opus)
   Prompt: "Here are N candidates backed by the week's evidence.
   Pick the ONE with highest mission value and lowest regression risk.
   Defend your choice against the strongest objection to each candidate.
   Refuse to pick any candidate that reduces agentic capability in
   exchange for a performance metric — return NULL instead."
   Opus returns: {selected_id, rationale, objections_considered} OR NULL.
5. If NULL → log "no candidate worth running tonight", skip to 9.
6. Fresh worktree: git worktree add .worktrees/forge-<ts> off main
   Claude Code operates ONLY inside the worktree.                 (1 Opus)
7. Implement + test inside worktree:
   - Capture: git log <worktree> ^main, npm test stdout + exit, git diff main
   - If no commits, or test exit != 0, or test stdout empty → fail hard.
   - "status: ok" requires all three artifacts to be non-empty and consistent.
8. Rolling replay regression check:                               (free)
   Sample 20 real exchanges from last 7 days, stratified.
   For each: run against worktree bot AND main bot.
   EVO 30B grades each diff: "would this be better or worse for James
   at the time, given what he was actually working on?"
   ≥1 "worse" judgment = reject. 0 worse and ≥2 better = pass.
9. Branch-first deploy (no direct commit to main):
   - Push worktree commits to forge/<date>-<slug>
   - CI runs in a clean clone: tests, lint, scope checks, banned-file check
   - If Tier A and CI green: auto-merge
   - If Tier B and CI green AND replay passed: auto-merge
   - If Tier C or any gate failed: open DM proposal card to James
10. Remove worktree. Log final event.
```

**Budget cap (hard)**

Two Opus sessions per deep night. Session 1 is the selection call. Session 2 is the implement+test call. If selection returns NULL, session 2 doesn't fire. If implementation hangs for any reason, the runner kills it at 2 hours wall-clock and records the failure — no "still running, will just wait". Budget is tracked live by the runner and exceeded calls are refused.

**Tiers (for deploy classification only)**

- **Tier A:** text/prompts/config/eval-labels/skill canHandle additions. No source code changes to `src/`. Auto-merge on green CI.
- **Tier B:** source code changes within scope limits (≤5 files, ≤150 lines, no banned files), with passing tests and passing replay regression check. Auto-merge on green CI AND green replay.
- **Tier C:** anything touching banned files (`src/tasks/forge-orchestrator.js`, `src/message-handler.js`, `src/router.js`, `src/cortex.js`, `src/memory.js`, `CLAUDE.md`, `docs/superpowers/**`), or >150 lines, or >5 files, or failing any gate. Opens a proposal card DM; never auto-merges.

Banned file list lives in `src/overnight/tiering.js` and is read at gate-check time. The list is code-level, not prose-level, so the gate actually enforces it.

**On-demand emergency mode**

Identical pipeline, identical budget, triggered by DM. Used when you want the bot to take a real swing at something specific overnight rather than waiting for Saturday. Emergency mode does not share a budget window with the scheduled Saturday run — if you run emergency on Wednesday, Saturday still gets its full 2 sessions.

---

## 5. Component detail

### 5.1 Rolling replay regression check

Replaces the "frozen capability probe suite" concept that was in earlier drafts of this design. Replay is strictly better because it stays grounded in what James is actually doing.

**Inputs**
- Worktree bot (with the proposed change)
- Main bot (unchanged baseline)
- Sample of 20 real exchanges from `data/conversation-logs/` stratified by:
  - Channel: DMs vs groups (roughly proportional to traffic)
  - Category: at least one each from CONVERSATIONAL, PLANNING, RECALL, SYSTEM, GENERAL_KNOWLEDGE
  - Complexity: mix of short/long, tool-calling vs pure chat

**Procedure**
1. For each sampled exchange, reconstruct the context as it was at the time (conversation so far, memory state snapshot if available, system knowledge snapshot).
2. Run the same input through both bots. Capture full responses.
3. If the two responses are textually near-identical (Levenshtein ratio >0.9), record as `neutral` without judging.
4. Otherwise ask EVO 30B with this rubric:
   > Given this exact input and the context James was in at the time, is Response B (worktree) better, worse, or neutral compared to Response A (main)? Base your judgment on: (a) accuracy and correctness, (b) evidence citation and memory use, (c) reasoning depth and adversarial quality, (d) completeness, (e) alignment with James's stated communication style. Do NOT consider latency, cost, or response length in isolation. Return `better`, `worse`, or `neutral` with one-sentence reasoning.

**Verdict**
- Any `worse` judgment → **reject**, log which exchange triggered it, write to event log with evidence refs.
- ≥2 `better` judgments and zero `worse` → **pass**.
- All `neutral` → **pass with warning** (flagged as "change had no material effect on real conversations — why was it proposed?").

**Privacy note:** replay uses real conversation content. Content stays on EVO (local). EVO 30B does the grading. No legal-client-identifiable content is ever sent to cloud models during replay. If a sampled exchange contains a client name that matches a frozen "sensitive term" list, the replay is skipped and a different exchange is sampled.

### 5.2 Fresh worktree invariant

The single most important structural fix. Without this, none of the other gates matter.

**Rule**

No overnight phase that modifies code operates on the main checkout. Every code-modifying phase starts by creating a git worktree:

```bash
WT=.worktrees/forge-$(date +%Y%m%d-%H%M%S)
git worktree add "$WT" main
```

The phase's Claude Code CLI is invoked with `cwd: $WT`. The phase's git operations (`git log`, `git diff`, `git status`, `git add`, `git commit`, `git push`) all target the worktree. No operation in the worktree can affect the main checkout.

At phase end (success or failure):
```bash
git worktree remove --force "$WT"
```

Worktrees are named with a timestamp so concurrent runs can't collide. A janitor sweep at the start of every overnight session removes any orphaned worktrees from previous runs before starting new ones.

**What this fixes**
- Last night's failure mode (pre-existing uncommitted main content showing up in the forge's "diff") becomes structurally impossible. The worktree has no uncommitted content because it was freshly checked out.
- The runtime state files (`data/group-registry.json`, `data/learned-rules.json`, etc.) still get written by the live bot on main, but they don't exist in the worktree because the worktree's checkout is a clean copy. Gate checks on "is the diff clean" become meaningful.
- Multiple forge attempts per night (e.g., in emergency mode) can run sequentially or concurrently without touching each other.

### 5.3 Branch-first deployment

No phase commits directly to main. Every change lands via:

```
forge/<date>-<slug>  →  push  →  CI  →  merge (auto or via James)
```

CI runs in a completely clean clone of the repo on EVO (not in the worktree, not on main). The CI pipeline is a single shell script: `scripts/forge-ci.sh <branch>`. It:

1. Clones the repo fresh into `/tmp/forge-ci-<ts>`.
2. Checks out the target branch.
3. Runs `npm ci`.
4. Runs `npm test`.
5. Runs `npm run lint` (if defined).
6. Runs `scripts/forge-scope-check.sh <branch>` which verifies: file count, line count, no banned files, no runtime state files.
7. Runs the rolling replay regression check against a snapshot of the last 7 days of exchanges.

All checks must pass for auto-merge. Any failure posts a DM proposal card.

**Rollback primitive:** `git revert <merge-commit>`. Single command, same every time, works for every change. The bot exposes a `/revert` command that reverts the most recent forge merge and restarts.

### 5.4 Event log schema

One file per night, append-only, JSONL:
```
data/overnight/events-<YYYY-MM-DD>.jsonl
```

Every event has this shape:
```
{
  "id": "<uuid>",
  "timestamp": "<iso>",
  "stage": "consolidate" | "probe" | "improve" | "report",
  "phase": "<stage-specific substep>",
  "inputs": [<artifact refs>],
  "outputs": [<artifact refs>],
  "verdict": "ok" | "rejected" | "failed" | "skipped" | "null",
  "reason": "<short human string>",
  "evidence_refs": [<hashes or paths>],
  "rollback_ref": "<git sha if applicable>",
  "budget": { "opus_sessions": <n>, "tokens": <n> }
}
```

The morning report is generated by querying this file. Historical analysis (e.g., "what did the bot try this week?") is a query over the collection of files. Every claim in the report must reference at least one event ID so you can trace it back.

**No event = did not happen.** If a phase completes without writing an event, the runner treats it as a failure and writes a synthetic `verdict: failed, reason: "no event produced"` entry. This defends against silent successes.

### 5.5 Budget model

**Max 20x subscription window:** realistically ~10 substantial Claude Code sessions per 5-hour window. Overnight covers roughly two windows, giving a theoretical ceiling of ~20 sessions. We target ≤10 used per night to leave headroom.

**Nightly budgets**

```
Cheap night   (5/week)    0-1 Opus sessions
Deep night    (Saturday)  ≤2 Opus sessions
Emergency     (on demand) ≤3 Opus sessions (selection + implement + fallback review)
```

**Enforcement**

- The overnight runner tracks Opus sessions started via Claude Code CLI invocations.
- Each stage declares its budget before running.
- A stage attempting to exceed its budget is **refused** — the call returns a budget-exceeded error and the stage records a `verdict: skipped, reason: "budget exceeded"` event.
- Budget counters reset at 22:00 London each night.

**Visibility**

Every morning report shows the budget section with actual vs allowed. If budgets are consistently maxed, James knows to tighten. If under-used, James knows there's headroom.

### 5.6 Weekly grooming and decay

The weekly observation log accumulates for 7 days, then rolls over. At Sunday 23:59 London:

1. The current week's log is archived to `data/overnight/archive/observations-<iso-week>.jsonl`.
2. A fresh `observations-<next-iso-week>.jsonl` is created Monday 00:00.
3. Any observation older than 3 weeks (i.e., archived two weeks ago or earlier) has its weight halved permanently.
4. Any observation older than 12 weeks is dropped from all active calculations (still present in archive files for forensic lookup).

The weekly improve run only reads the current week's log. Historical context (e.g., "has this pattern been observed before?") comes from the grooming step asking EVO 30B to scan the two most recent archive files for matches, not from loading them into active selection.

---

## 6. Preconditions (must be done before implementation)

### 6.1 Git hygiene

Three items must be true before the fresh-worktree invariant is actually meaningful:

**P1. Runtime state files excluded from git.** These four files are written to by the live bot at runtime and should not be tracked:
```
data/group-registry.json
data/learned-rules.json
data/projects.json
data/system-knowledge/meta.json
```
They are moved to `data/runtime/` and added to `.gitignore`. Any code that reads them is updated to the new path. A one-time commit captures the current content as an initial default baked into the repo (or shipped via a seed script), so a fresh clone still has something sensible.

**P2. `.gitattributes` forces LF line endings.**
```
* text=auto eol=lf
*.js text eol=lf
*.ts text eol=lf
*.json text eol=lf
*.md text eol=lf
*.sh text eol=lf
```
This stops Windows clones from showing every file as "modified" due to CRLF conversion and stops future forge diffs being polluted with line-ending noise.

**P3. Local clones synced with EVO.** Before the implementation phase starts, every working clone (including James's Windows clone) does `git fetch && git pull` so the baseline is current. This is a procedural step, not code.

### 6.2 Staleness cleanup

Before the first real morning report is generated from the new pipeline, existing stale items must be flushed:

- All items in `data/overnight-results/` older than the current ISO week are moved to `data/overnight-results/.archive/`.
- Any in-memory "recommended" state that the current overnight-report.js carries from session to session is reset.
- The ATLAS recommendation (specifically, and any other item older than 14 days with no current-week evidence) is explicitly archived with a note in the first new report: *"Archived N stale recommendations from the previous architecture. See .archive/ for content."*

### 6.3 Rolling replay sample availability

The rolling replay regression check (§5.1) needs at least 7 days of conversation logs to draw from. This is already satisfied on EVO (logs go back weeks). No seed file is needed — replay samples real logs directly. If logs are ever thin (e.g., after a bot restart that loses recent history), replay silently falls back to the longest window available and notes the reduced sample size in the event log.

This section exists explicitly to head off confusion: there is **no frozen probe suite**. Earlier drafts of this design proposed one; it was rejected because it goes stale and doesn't track real use. The regression check is rolling replay over real logs, period.

---

## 7. What gets retired

These files are removed or drastically reduced as part of the implementation:

| File | Action |
|---|---|
| `src/tasks/forge-orchestrator.js` (879 lines) | Replaced by `src/overnight/improve.js` (~300 lines target) |
| `src/overnight-report.js` (1038 lines) | Replaced by `src/overnight/report.js` (~200 lines, renders from event log) |
| `src/tasks/overnight-to-evolution.js` (158 lines) | Deleted — functionality merged into improve stage |
| `src/tasks/improvement-cycle.js` (176 lines) | Consolidate/extraction parts move to `src/overnight/consolidate.js`; self-improve and deep-think parts retire |
| `src/tasks/weekly-retrospective.js` (282 lines) | Folded into the weekly improve grooming pass |
| `src/tasks/manual-improvement-run.js` (50 lines) | Replaced by on-demand emergency mode in `src/overnight/improve.js` |
| `src/evolution.js`, `src/evolution-executor.js`, `src/evolution-gate.js` | Evaluated: likely retired entirely in favour of branch+CI deploy; decided during planning phase |
| `src/tasks/evolution-dispatch.js` | Retired with the evolution subsystem |

The scheduler's entries for these tasks are removed. A single `src/overnight/runner.js` takes over, declared once in `scheduler.js`.

---

## 8. What gets kept

- `src/memory.js` and the EVO memory service — evidence-chain enforcement is added to the schema, but the service itself is unchanged.
- `evo-memory/dream_mode.py` — still the dream extraction engine, but called from the new consolidate stage with a schema-validating wrapper.
- The trace analyser and the classifier — they produce inputs for the probe stage.
- `src/tasks/briefing.js`, `src/tasks/todo-reminders.js`, `src/tasks/meeting-alerts.js`, `src/tasks/daily-backup.js`, `src/tasks/system-refresh.js`, `src/tasks/ground-truth.js`, `src/tasks/trace-analyser.js` — these are daytime or non-overnight tasks and are unaffected.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Worktree invariant forgotten in a new phase | All code-modifying operations go through a single `withWorktree(fn)` helper; any phase that bypasses it is caught by a lint rule |
| EVO grading is systematically lenient on replay | Occasional (monthly) sampling where James reviews a set of replay judgments and flags disagreements; if EVO's calibration drifts, the grading prompt is updated |
| Observation log grows without bound | Weekly rollover, 14-day decay, 12-week drop, explicit archival |
| Saturday forge consistently produces NULL | After 3 consecutive NULL weeks, the bot escalates to James with a DM: "the bot can't find anything worth doing — is there a direction you want?" |
| Max subscription window exhausted by daytime use | Budget counter is shared between overnight and daytime; overnight refuses to start if <5 sessions remain in the window |
| Runtime state files accidentally committed by a phase | `forge-scope-check.sh` explicitly rejects any diff touching `data/runtime/` |
| Morning report becomes unreadably long | Hard cap at 4000 words; if exceeded, report is split into a "headline" (in-DM) and a "full" version (linked or attached) |
| Replay privacy leak | Sensitive-term list skips exchanges; all grading stays on EVO 30B (local) |
| The bot's mission clause is interpreted liberally | `mission_alignment` check is a deterministic keyword/heuristic filter in `improve.js`, not a subjective prompt — any candidate whose title contains "simpler", "faster at the cost of", "remove", "abandon", "skip" in combination with capability-related terms is auto-flagged for review |

---

## 10. Out of scope

Explicitly not part of this pass:

- Rewriting cortex.js for latency (last night's failed proposal). If cortex is slow, it will appear in the probing pass with evidence; a future deep run can propose a fix that the new architecture will either accept or reject on its merits.
- Precompute/sleep-time compute for morning queries. Attractive but additional surface area; defer until the core three stages are stable.
- Full TypeScript migration of the overnight code. New files (`src/overnight/*.ts`) are written in TypeScript; existing retained files keep their current language until they're next touched.
- Changes to the bot's runtime (chat response) behaviour. This spec is about overnight processes only. The cortex/router/prompt/memory paths are unchanged at runtime.
- Full replacement of the evolution subsystem. Likely retired, but the decision is deferred to the planning phase with a clear fallback (keep it as a read-only display of historical evolution tasks until someone needs it again).
- Dashboard changes. The Rust dashboard on the Pi will need to know about the new event log, but that's a follow-up.

---

## 11. Success criteria

Before this work can be considered done:

1. **A full cheap night runs end-to-end** producing a consolidate + probe + report cycle with zero Opus sessions, all events logged, and a morning report that passes the staleness guard.
2. **A full deep night runs end-to-end** with the 2-Opus-session budget, a selection call (possibly returning NULL), and if non-NULL, a worktree-based implement + replay-graded + branch-based merge.
3. **The ATLAS regression is explicitly fixed** — a morning report generated against existing logs does not surface ATLAS unless there is current-week evidence for it. Verified by running the new report generator against this week's data and grep-ing for ATLAS.
4. **Last night's failure mode is structurally reproduced and contained** — a synthetic test injects a stuck Claude CLI prompt; the runner detects "no commits produced" and records the phase as failed.
5. **All three git hygiene preconditions are in place** and verified: `.gitattributes` present, runtime state files in `data/runtime/` with `.gitignore` entry, local clones on latest main.
6. **The morning report layout is stable and predictable** — five consecutive mornings produce reports with identical section order and headings.
7. **The retired files are actually retired** — no references to `forge-orchestrator.js`, `overnight-to-evolution.js`, or the old `overnight-report.js` remain in the active codebase.

---

## 12. Deferred questions

These are things the implementation plan will need to decide, not the spec:

- Exact cron times for each cheap-night stage (the 22:00-06:45 layout in the earlier drafts is indicative, not prescriptive).
- Exact shape of the forge-ci.sh script (pass/fail predicates, where snapshots are stored).
- Whether the event log is per-night files or one rolling file with a rollover policy.
- Whether the emergency trigger is a chat command, an HTTP endpoint, or both.
- How the rolling replay's sample stratification is parameterised.
- The precise banned-files list (current best guess is in §4.4 but needs review during planning).

---

*End of spec.*
