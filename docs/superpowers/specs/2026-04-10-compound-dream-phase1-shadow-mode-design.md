# Compound Dream — Phase 1 Shadow Mode (addendum)

**Spec date:** 2026-04-10
**Author:** James C (with Claude)
**Supersedes:** the "shadow-mode via `run-consolidate-manual.ts`" approach in `docs/superpowers/plans/2026-04-10-compound-dream-phase1-consolidate.md`
**Status:** Design — awaiting implementation plan
**Parent spec:** `docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md` §4.1

---

## 1. Why this exists

Phase 1 shipped the `CONSOLIDATE` stage (`src/overnight/consolidate.ts` and friends) with a manual-invocation harness (`run-consolidate-manual.ts`) intended to run in shadow mode alongside the existing 2 AM task for three nights before cutover. On first run against EVO the harness produced zero signal: the memory client starts `_online: false`, `extractFromConversation` silently queued to disk instead of calling EVO, candidates came back empty, and the rejected log was never created. The 3-night soak would have accumulated nothing useful.

This addendum replaces the standalone-harness approach with an in-process scheduler entry. The new stage runs inside the bot's own scheduler tick so the memory client is warm, produces a per-night JSONL file of validated candidates for parity review, and does not disturb the old 2 AM task during the soak.

The goal is unchanged: verify that the new consolidation pipeline produces the same memory entries as the old one (with added evidence metadata) before making it the real one. Shadow mode is pure risk management for cutover — it does not itself feed downstream stages.

---

## 2. Problem statement

Three concrete failures the original plan did not anticipate:

1. **Cold memory client.** Standalone scripts invoked via `npx tsx` do not inherit the live bot's `_online: true` state. The memory client only flips online after `checkHealth()` succeeds on a periodic tick that does not run in a one-shot process. Without warmup, every `extractFromConversation` call queues to disk and returns `{ extracted: [], queued: true }`.

2. **Zero-signal rejected log.** The original plan assumed the rejected log would fill with entries flagged `no_evidence` because EVO's extractor does not currently emit per-line `sources[]`. In practice extract was never reached, so there was nothing to reject.

3. **No parity mechanism.** "Shadow mode" in the original plan meant "the new code runs alongside the old code". It did not define a way to compare the two paths' outputs. If we had produced rejected entries, we would still not have had a way to say "the new pipeline handled this conversation the same as the old one".

---

## 3. Design overview

One new scheduler entry, five new files under `src/overnight/`, one new export in `src/memory.js`, and one new line in `src/scheduler.js`. Nothing else changes.

```
02:00 London  checkOvernightExtraction        (unchanged, old 2 AM task)
02:30 London  checkConsolidateShadow          (new, runs the Phase 1 stage in shadow mode)
```

Both run inside the bot process. The bot's memory client is already warm when either fires. The old task keeps writing memories to EVO as it always has. The new task calls EVO `/extract` with `store_results: false` so EVO returns candidates without double-storing, synthesizes a conversation-level `sources[]` field (hash + excerpt) on each candidate so the Phase 1 validator passes, and writes validated candidates to `data/overnight/shadow-candidates-<YYYY-MM-DD>.jsonl` on EVO. No EVO memory-state writes from the new path.

After three nights of shadow data accumulation, a single follow-up commit promotes the shadow sink to a real memory-store call and disables the old 2 AM task line. Cutover is one commit, reversible by `git revert` in 10 seconds.

### 3.1 Why in-process and not systemd/cron

Two reasons. First, the bot's memory client is already warm at 02:30 because the scheduler tick keeps calling `checkEvoHealth()` every 60 seconds. An in-process task sidesteps the cold-start problem entirely without any warmup plumbing. Second, a scheduler entry is the same shape as every other overnight task in the codebase (`checkOvernightExtraction`, `checkOvernightReport`, etc.); it reuses the existing `runTask` wrapper for logging, error containment, and retry semantics, none of which a standalone cron job gets for free.

### 3.2 Why 02:30 and not 02:00

Two reasons. First, running at exactly the same minute as `checkOvernightExtraction` would produce overlapping EVO calls for the same conversations, adding contention on the memory service during its busiest minute of the day. Second, a 30-minute offset means the two tasks are clearly separable in logs — if something goes wrong, the event-log timestamps make it obvious which task did what.

### 3.3 Why synthesize sources and not wait for real ones

Real per-line `sources[]` requires modifying `evo-memory/dream_mode.py` to emit hash+excerpt for each extracted candidate. That is a Python-side change on a file explicitly marked out of scope for Phase 1. Synthesizing at the Node boundary gives us a working parity signal today with a clear upgrade path: when EVO is updated, the synthesizer is either deleted or becomes a fallback for candidates that EVO returned without a source.

The synthesized source is symbolic — it says "this candidate came from this conversation" rather than "this candidate came from line 47 of this conversation". That is strictly weaker than the spec's line-level invariant. Shadow mode accepts the weaker form; cutover with real sources is a later, separate milestone.

---

## 4. Component detail

### 4.1 `src/overnight/consolidate-source-synthesizer.ts`

Pure module with one exported function:

```ts
export function synthesizeSources(conversation: string): MemorySource[];
```

Returns `[{ hash: 'sha256:' + crypto.createHash('sha256').update(conversation).digest('hex'), excerpt: conversation.slice(0, MAX_EXCERPT_CHARS) }]`.

Deterministic, no I/O, no dependencies beyond `node:crypto` and the `MemorySource` type from `consolidate-validate.ts`.

### 4.2 `src/overnight/consolidate-shadow-sink.ts`

Class `ShadowSink` implementing the `StoreClient` interface from `consolidate-store.ts`. Constructor takes `{ overnightDir: string }`. `storeValidated(candidate)` appends a JSONL line `{ timestamp, candidate }` to `<overnightDir>/shadow-candidates-<todayStr>.jsonl`. Creates the directory on first write. Uses `todayStr` from a constructor-injected date so tests can pin it.

Never touches the EVO memory service. Never calls `storeMemory()`. Write errors propagate to the caller, where `ConsolidateStore` captures them in `storeErrors`.

### 4.3 `src/overnight/consolidate-shadow-task.ts`

Top-level task function:

```ts
export async function checkConsolidateShadow(
  todayStr: string,
  hours: number,
  minutes: number,
): Promise<void>;
```

Gated on `hours === 2 && minutes === 30`. Guarded by an in-module `lastRunDate` so it only fires once per day even if the scheduler tick misbehaves.

Inside the gate:
1. Build an `ExtractClient` that calls a new `extractWithoutStoring` from `memory.js` and, for each candidate returned, attaches `synthesizeSources(conversation)` as the `sources` field before handing it to the stage.
2. Build a `ShadowSink` with `overnightDir = data/overnight`.
3. Build real `MaintenanceClient` and `TopicIndexClient` wrappers around the existing `triggerMaintenance`, `indexDayTopics`, `pruneTopicIndex` exports. (Same wrappers as `run-consolidate-manual.ts` already has — can be extracted if they grow.)
4. Call `makeConsolidateStage({ logDir, extractClient, storeClient: shadowSink, memoryClient, topicClient, yesterdayFor })`.
5. Run via a new `OvernightRunner({ mode: 'cheap', date: todayStr, overnightDir, repoRoot, skipJanitor: true })` with stage `['consolidate']`.

Maintenance re-runs: per user decision, the new stage runs maintenance + topic indexing every night even though the 2 AM task already did. Both are idempotent; the waste is a few EVO calls.

### 4.4 `src/memory.js` — new export

```js
export const extractWithoutStoring = (conversation, source) =>
  client.extractWithoutStoring(conversation, source);
```

And on `MemoryClient`:

```js
async extractWithoutStoring(conversation, source = 'conversation') {
  if (!this._online) return { extracted: [], offline: true };
  try {
    return await this._fetch('/extract', {
      method: 'POST',
      body: JSON.stringify({ conversation, store_results: false, source }),
      timeout: TIMEOUTS.MEMORY_EXTRACT,
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'EVO X2 extractWithoutStoring failed');
    return { extracted: [], error: err.message };
  }
}
```

Key difference from `extractFromConversation`: `store_results: false` in the request body and no queuing on failure. If EVO is offline or the call fails, the method returns an empty result with an `offline` or `error` flag — the stage logs it as an event and continues. Queuing is wrong for shadow mode because a queued extract would eventually be replayed by the live bot and double-store.

### 4.5 `src/scheduler.js` — new line

One addition to `runScheduler`:

```js
await runTask('consolidateShadow', () => checkConsolidateShadow(todayStr, hours, minutes));
```

Placed immediately after the `overnightExtraction` line. Import added at the top of the file.

### 4.6 Retired: `src/overnight/run-consolidate-manual.ts`

The standalone harness shipped in Phase 1 commit `30356cb` is no longer used by shadow mode. It remains on disk as a dev tool for manual debugging but is not referenced by anything in the scheduler. Removing it is optional cleanup deferred past this addendum.

---

## 5. Data flow

Per night, in order:

1. **02:00** — existing `checkOvernightExtraction` fires. Old path calls `extractFromConversation` with `store_results: true` on each of yesterday's conversation logs. EVO stores the resulting memories. **Unchanged from current behaviour.**

2. **02:30** — `checkConsolidateShadow` fires. Stage runs:
   - **Extract phase**: iterate yesterday's log files, assemble each conversation, call `extractWithoutStoring`. EVO returns candidates without storing. For each candidate, attach `synthesizeSources(conversation)`. Push to the `candidates` array. Write one event to `events-<today>.jsonl`.
   - **Store phase**: for each candidate, run `validateCandidate` (Phase 1 validator). All well-formed candidates pass because sources were synthesized. Each validated candidate is appended to `shadow-candidates-<today>.jsonl` via `ShadowSink`. Write one event.
   - **Maintenance phase**: call `triggerMaintenance`, `indexDayTopics(yesterday)`, `pruneTopicIndex(30)`. Write one event.

3. **Morning of day 2, 3, 4** — user inspects `shadow-candidates-<yesterday>.jsonl` on EVO and compares it to the memories the old 2 AM task stored in EVO state. No tooling for this comparison — manual review.

4. **Morning of day 4 (after 3 nights of shadow data)** — user says "cut over". A single commit (a) replaces `ShadowSink` with a real `storeMemory()` wrapper, (b) comments out the old `overnightExtraction` runTask line, (c) moves the `consolidateShadow` runTask to gate on `hours === 2 && minutes === 0` and renames it to `consolidate`. `improvement-cycle.js` stays on disk but becomes unreachable.

---

## 6. Error handling

Every error path degrades to "write an event, continue":

- **Memory client offline at 02:30**: `extractWithoutStoring` returns `{ extracted: [], offline: true }`. The stage's extract phase records `files=N candidates=0` and logs `errors=0`. The store and maintenance phases run normally (maintenance will also report offline). No crash.
- **EVO `/extract` throws**: per-file error captured in `result.errors`, next file continues. Event carries error list in `evidence_refs`.
- **Shadow file write fails**: `ShadowSink.storeValidated` throws, `ConsolidateStore` captures in `storeErrors`, event reports `store_errors=N`. Stage continues.
- **`checkConsolidateShadow` itself throws**: `runTask` wrapper in `scheduler.js` catches and logs, next scheduler tick at 02:31 does not re-enter because of the `lastRunDate` guard. Task silently retries the following night.
- **Tick missed (bot restart at 02:29)**: no catch-up. The day's shadow file is simply not created. Morning review spots the gap.

No new failure modes beyond what Phase 1 already handles.

---

## 7. Testing

Three new unit test files, all pure, no EVO calls:

1. **`consolidate-source-synthesizer.test.ts`** (~5 tests)
   - Identical input produces identical hash (deterministic).
   - Different input produces different hash.
   - Excerpt is clipped at `MAX_EXCERPT_CHARS`.
   - Empty conversation returns a source with empty excerpt and a stable hash.
   - Output always has exactly one source.

2. **`consolidate-shadow-sink.test.ts`** (~4 tests)
   - Writes one JSONL line per `storeValidated` call.
   - Second call to the same date appends, doesn't overwrite.
   - Creates the overnight directory if it doesn't exist.
   - File contents parse as valid JSONL with `{timestamp, candidate}` shape.

3. **`consolidate-shadow-task.test.ts`** (~4 tests)
   - Does nothing when `hours !== 2` or `minutes !== 30`.
   - Runs exactly once per day even if called at 02:30 twice.
   - End-to-end: mocked extract/memory/topic clients, writes three events, produces a shadow file with the expected candidates.
   - Handles an offline memory client without throwing.

No integration tests. Phase 1's 28 existing tests already cover the stage's composition.

---

## 8. Cutover criteria

After three consecutive nights of shadow file output (mornings of days 2, 3, 4 relative to the deploy), the user reviews the shadow files by hand and asks: do the candidate texts, categories, and counts look roughly like what the old 2 AM task was producing? If yes, tell me "cut over". If no — e.g. corrupt text, missing categories, counts wildly off, or a night with zero candidates when the old task produced many — we diagnose and iterate before touching production. No automated parity checker; review is manual and judgment-based because the goal is confidence, not a test.

**Cutover commit contents:**

1. In `consolidate-shadow-task.ts`: replace `new ShadowSink(...)` with a `StoreClient` that calls the real `storeMemory(...)` from `memory.js`. Remove source synthesis — if EVO is still not emitting real sources by then, raise it as a separate pre-cutover blocker.
2. In `scheduler.js`: comment out `await runTask('overnightExtraction', …)` and replace with `await runTask('consolidate', () => checkConsolidate(todayStr, hours, minutes))`. Rename `checkConsolidateShadow` → `checkConsolidate` and change its gate to `hours === 2 && minutes === 0`.
3. Leave `src/tasks/improvement-cycle.js` on disk. It becomes dead code. Removal is a later cleanup commit, not part of cutover.

**Rollback:** `git revert <cutover-sha>`. One command, no data loss. The old path wakes up at the next 02:00 tick.

---

## 9. What stays untouched

- `src/tasks/improvement-cycle.js` — the old 2 AM task runs exactly as before throughout shadow mode.
- `evo-memory/dream_mode.py` — Python extractor unchanged; real per-line `sources[]` is a future, Python-side task.
- `src/overnight/consolidate.ts` and the four sub-modules — Phase 1 stage composition is unchanged, reused as-is.
- `src/overnight/runner.ts`, `events.ts`, `budget.ts`, `tiering.ts`, `worktree.ts` — Phase 0 infrastructure reused as-is.
- `src/overnight/run-consolidate-manual.ts` — remains on disk as a dev tool, not invoked by anything.

---

## 10. Out of scope

- Real per-line `sources[]` from EVO's Python extractor (future Python-side task).
- Automated parity comparison between the shadow file and EVO memory state (manual review is sufficient for three nights).
- Removing `improvement-cycle.js`, `overnight-to-evolution.js`, or the legacy `overnight-report.js` — all retired in Phase 5.
- The PROBE, REPORT, and IMPROVE stages (Phases 2–4).
- Any change to bot runtime behaviour. Shadow mode only touches what runs between 02:30 and 02:31 London.

---

## 11. Success criteria

1. Three consecutive nights (days 2, 3, 4 after deploy) produce a non-empty `shadow-candidates-<date>.jsonl` file on EVO with at least one validated candidate per file.
2. The event log for each of those nights contains three consolidate events (`extract`, `store`, `maintenance`) with `verdict: ok` or a clearly diagnosed failure reason.
3. Manual review of the three shadow files on morning 4 finds candidate texts, categories, and counts in the same ballpark as the old 2 AM task's EVO memory writes for those nights.
4. The old 2 AM task continues to run without behavioural change throughout the soak.
5. A one-commit cutover replaces the shadow sink with real storage and disables the old 2 AM task, reversible by single `git revert`.

---

## 12. Open questions (decided in planning phase)

- Exact file layout for shadow candidates (one line per candidate? per run? per conversation?).
- Whether `lastRunDate` guarding lives in `checkConsolidateShadow` or in a general scheduler-level idempotency helper.
- Whether `extractWithoutStoring` should be a new method on `MemoryClient` or a new top-level helper in `memory.js`.
- Whether `ShadowSink` writes to the current day's file keyed by `todayStr` or yesterday's file keyed by the conversation date (the event log and rejected log already key on `todayStr`, so consistency suggests the same).

---

*End of addendum.*
