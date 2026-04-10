# Compound Dream — Phase 1 Shadow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md`

**Parent spec:** `docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md` §4.1

**Depends on:** Phase 1 CONSOLIDATE stage (commits `7f4f89c` through `30356cb`, currently shipped on `origin/main` and deployed on EVO).

**Goal:** Replace the broken standalone-harness shadow approach with an in-process scheduler entry that runs the Phase 1 CONSOLIDATE stage every night at 02:30 London, synthesizes conversation-level `sources[]` metadata, and writes validated candidates to `data/overnight/shadow-candidates-<date>.jsonl` on EVO for three nights of manual parity review before cutover.

**Architecture:** One new scheduler runTask entry at 02:30 invoking a new task function `checkConsolidateShadow`. The task function composes the existing Phase 1 stage with three new supporting modules — a pure source synthesizer, a file-based shadow sink implementing `StoreClient`, and a new `MemoryClient.extractWithoutStoring` method that calls EVO `/extract` with `store_results: false`. Dependency injection throughout: the task function takes a `deps` parameter defaulting to real clients so tests can supply mocks without `esmock`. Old 2 AM task untouched during the three-night soak.

**Tech Stack:** TypeScript strict (all new files), `tsx` runner, `node:test` + `mock.fn()` for tests, `node:crypto` for source hashing, `node:fs/promises` for the shadow sink, existing `runTask`/`getLondonTime` pattern from `src/scheduler.js`.

**Code standards compliance (from CLAUDE.md):**
- All new files under 300 lines (none will exceed ~150).
- Classes for stateful services (`ShadowSink` has file state — it's a class). Pure functions stay functions (`synthesizeSources`).
- Manual dependency injection via constructor params and a `deps` default-parameter pattern on the task function. No DI container.
- TypeScript strict, no `any`, no `@ts-ignore`. Public methods have JSDoc one-liners.
- No silent failures. Every catch block either handles, re-raises with context, or has `// intentional: [reason]`.
- All constants in the file that uses them or in an existing constants module. Magic numbers (02:30, 200 char excerpt limit, 30-day topic prune) defined once and named.
- Tests use injected mocks; never touch real EVO, real filesystem outside tmpdir, or real sockets.

**Out of scope for this plan:**
- Touching `src/tasks/improvement-cycle.js`. Its 02:00 entry continues to run unchanged throughout the shadow soak.
- Modifying `evo-memory/dream_mode.py` to emit real per-line `sources[]`. Synthesized sources are the Phase 1 compromise.
- The cutover commit itself (deferred until the user reviews three nights of shadow output).
- Removing `run-consolidate-manual.ts`. It stays on disk as a dev debugging tool.
- PROBE, REPORT, IMPROVE stages (Phases 2–4).

---

## File Structure

**Created by this plan:**

```
src/overnight/consolidate-source-synthesizer.ts                    Pure hash+excerpt synthesizer
src/overnight/consolidate-shadow-sink.ts                           ShadowSink StoreClient impl
src/overnight/consolidate-shadow-task.ts                           checkConsolidateShadow task fn
src/overnight/__tests__/consolidate-source-synthesizer.test.ts     5 pure tests
src/overnight/__tests__/consolidate-shadow-sink.test.ts            4 tmp-dir tests
src/overnight/__tests__/consolidate-shadow-task.test.ts            5 DI-mocked integration tests
```

**Modified by this plan (surgical only):**

```
src/memory.js                  Add extractWithoutStoring method (line ~180) + named export (line ~576)
src/scheduler.js               Add import (line ~12) + one runTask call (line ~94)
```

**Deliberately NOT modified:**

```
src/tasks/improvement-cycle.js      Retired in Phase 5; runs unchanged during soak
src/overnight/consolidate.ts        Phase 1 stage composition reused as-is
src/overnight/runner.ts             Phase 0 infrastructure reused as-is
src/overnight/events.ts             Phase 0 infrastructure reused as-is
src/overnight/run-consolidate-manual.ts  Remains as dev tool, not wired into anything
evo-memory/dream_mode.py            Python extractor unchanged
```

---

### Task 1: Source synthesizer — `src/overnight/consolidate-source-synthesizer.ts`

**Files:**
- Create: `src/overnight/consolidate-source-synthesizer.ts`
- Create: `src/overnight/__tests__/consolidate-source-synthesizer.test.ts`

**Reason:** The Phase 1 validator rejects any candidate missing `sources[]`. EVO's current extractor does not emit a sources field. The synthesizer attaches a deterministic conversation-level source (`sha256` hash + 200-char excerpt) to every candidate EVO returns so the validator passes during shadow mode. The real line-level invariant turns on at cutover when EVO is updated.

Build this first: pure, deterministic, no I/O, no external dependencies beyond `node:crypto` and the `MemorySource` type already exported from `consolidate-validate.ts`. Everything else in this plan consumes it.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-source-synthesizer.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeSources,
  SYNTHETIC_HASH_PREFIX,
} from '../consolidate-source-synthesizer.js';
import { MAX_EXCERPT_CHARS } from '../consolidate-validate.js';

describe('overnight/consolidate-source-synthesizer.synthesizeSources', () => {
  it('returns exactly one source', () => {
    const result = synthesizeSources('James: hello world\nClint: hi James');
    assert.equal(result.length, 1);
  });

  it('is deterministic: identical input produces identical hash', () => {
    const input = 'James: the deadline is Tuesday\nClint: noted';
    const a = synthesizeSources(input);
    const b = synthesizeSources(input);
    assert.equal(a[0]!.hash, b[0]!.hash);
    assert.equal(a[0]!.excerpt, b[0]!.excerpt);
  });

  it('different inputs produce different hashes', () => {
    const a = synthesizeSources('first conversation content here');
    const b = synthesizeSources('second conversation content here');
    assert.notEqual(a[0]!.hash, b[0]!.hash);
  });

  it('hash has the synthetic prefix and is the expected sha256 length', () => {
    const [src] = synthesizeSources('any content at all');
    assert.ok(src!.hash.startsWith(SYNTHETIC_HASH_PREFIX));
    // sha256 hex is 64 chars, plus the prefix
    assert.equal(src!.hash.length, SYNTHETIC_HASH_PREFIX.length + 64);
  });

  it('clips excerpt to MAX_EXCERPT_CHARS when conversation is longer', () => {
    const long = 'x'.repeat(MAX_EXCERPT_CHARS + 500);
    const [src] = synthesizeSources(long);
    assert.equal(src!.excerpt.length, MAX_EXCERPT_CHARS);
  });

  it('handles an empty conversation with a stable hash and empty excerpt', () => {
    const [src] = synthesizeSources('');
    assert.ok(src!.hash.startsWith(SYNTHETIC_HASH_PREFIX));
    assert.equal(src!.excerpt, '');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx tsx --test src/overnight/__tests__/consolidate-source-synthesizer.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` on `../consolidate-source-synthesizer.js`.

- [ ] **Step 3: Implement `src/overnight/consolidate-source-synthesizer.ts`**

Create `src/overnight/consolidate-source-synthesizer.ts`:

```ts
// src/overnight/consolidate-source-synthesizer.ts — synthetic source generator.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.1.
//
// Produces a deterministic conversation-level source (hash + excerpt) for
// candidates EVO returns during shadow mode. This is a Phase-1 compromise:
// the spec's full invariant requires per-line sources, but EVO doesn't
// currently emit them. Synthesized sources let the validator pass on
// well-formed candidates so parity review is possible. At cutover, real
// per-line sources replace these and the synthesizer is deleted or
// downgraded to a fallback.

import { createHash } from 'node:crypto';
import { MAX_EXCERPT_CHARS, type MemorySource } from './consolidate-validate.js';

/** Prefix that distinguishes synthetic sources from real line-level ones. */
export const SYNTHETIC_HASH_PREFIX = 'sha256:conv:';

/**
 * Build a single synthetic source for a whole conversation. Deterministic:
 * same input always produces the same hash and excerpt.
 */
export function synthesizeSources(conversation: string): MemorySource[] {
  const hash = createHash('sha256').update(conversation).digest('hex');
  const excerpt = conversation.slice(0, MAX_EXCERPT_CHARS);
  return [
    {
      hash: `${SYNTHETIC_HASH_PREFIX}${hash}`,
      excerpt,
    },
  ];
}
```

- [ ] **Step 4: Run test and confirm pass**

```bash
npx tsx --test src/overnight/__tests__/consolidate-source-synthesizer.test.ts
```

Expected: 6 passing tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-source-synthesizer.ts src/overnight/__tests__/consolidate-source-synthesizer.test.ts
git commit -m "$(cat <<'EOF'
feat(overnight): synthetic source synthesizer for shadow mode (spec §4.1)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shadow sink — `src/overnight/consolidate-shadow-sink.ts`

**Files:**
- Create: `src/overnight/consolidate-shadow-sink.ts`
- Create: `src/overnight/__tests__/consolidate-shadow-sink.test.ts`

**Reason:** The Phase 1 `ConsolidateStore` accepts any `StoreClient` implementation. Shadow mode needs a sink that writes validated candidates to a JSONL file on EVO's filesystem instead of calling `storeMemory()`. This class is exactly that implementation: it appends one JSONL line per candidate to `<overnightDir>/shadow-candidates-<todayStr>.jsonl`.

Stateful service (has file state and a date-key), so per CLAUDE.md it's a class. Dependency-injected `overnightDir` and `todayStr` — tests supply a tmpdir and a fixed date.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-shadow-sink.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowSink } from '../consolidate-shadow-sink.js';
import type { MemoryCandidate } from '../consolidate-validate.js';

describe('overnight/consolidate-shadow-sink.ShadowSink', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-shadow-sink-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeCandidate(text: string): MemoryCandidate {
    return {
      text,
      category: 'project',
      confidence: 0.85,
      sources: [{ hash: 'sha256:conv:abc', excerpt: text.slice(0, 50) }],
    };
  }

  it('writes exactly one JSONL line per storeValidated call', async () => {
    const sink = new ShadowSink({ overnightDir, todayStr: '2026-04-10' });
    await sink.storeValidated(makeCandidate('memory A'));

    const file = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.candidate.text, 'memory A');
    assert.ok(parsed.timestamp);
  });

  it('appends to an existing file instead of overwriting', async () => {
    const sink = new ShadowSink({ overnightDir, todayStr: '2026-04-10' });
    await sink.storeValidated(makeCandidate('first'));
    await sink.storeValidated(makeCandidate('second'));
    await sink.storeValidated(makeCandidate('third'));

    const file = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]!).candidate.text, 'first');
    assert.equal(JSON.parse(lines[1]!).candidate.text, 'second');
    assert.equal(JSON.parse(lines[2]!).candidate.text, 'third');
  });

  it('creates the overnight directory if it does not already exist', async () => {
    assert.ok(!existsSync(overnightDir));
    const sink = new ShadowSink({ overnightDir, todayStr: '2026-04-10' });
    await sink.storeValidated(makeCandidate('first'));
    assert.ok(existsSync(overnightDir));
  });

  it('uses the configured date in the filename', async () => {
    const sink = new ShadowSink({ overnightDir, todayStr: '2099-12-31' });
    await sink.storeValidated(makeCandidate('future memory'));
    assert.ok(existsSync(join(overnightDir, 'shadow-candidates-2099-12-31.jsonl')));
  });
});
```

- [ ] **Step 2: Run test and confirm it fails**

```bash
npx tsx --test src/overnight/__tests__/consolidate-shadow-sink.test.ts
```

Expected: FAIL with module-not-found on `../consolidate-shadow-sink.js`.

- [ ] **Step 3: Implement `src/overnight/consolidate-shadow-sink.ts`**

Create `src/overnight/consolidate-shadow-sink.ts`:

```ts
// src/overnight/consolidate-shadow-sink.ts — file-based StoreClient for shadow mode.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.2.
//
// Implements the StoreClient interface from consolidate-store.ts but writes
// validated candidates to a per-day JSONL file instead of calling EVO's
// memory service. Used only during the three-night shadow soak; replaced by
// a real memory-store client at cutover.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoreClient } from './consolidate-store.js';
import type { MemoryCandidate } from './consolidate-validate.js';

export interface ShadowSinkOptions {
  /** Absolute path to the overnight data directory (e.g. data/overnight). */
  overnightDir: string;
  /** YYYY-MM-DD date used in the output filename. */
  todayStr: string;
}

/**
 * File-based sink that appends validated candidates as JSONL to
 * `<overnightDir>/shadow-candidates-<todayStr>.jsonl`. One line per candidate.
 */
export class ShadowSink implements StoreClient {
  private readonly filePath: string;
  private dirEnsured = false;

  constructor(private readonly opts: ShadowSinkOptions) {
    this.filePath = join(opts.overnightDir, `shadow-candidates-${opts.todayStr}.jsonl`);
  }

  /** Append one candidate to the shadow file. Creates the directory on first call. */
  async storeValidated(candidate: MemoryCandidate): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.opts.overnightDir, { recursive: true });
      this.dirEnsured = true;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      candidate,
    };
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
  }
}
```

- [ ] **Step 4: Run tests and confirm pass**

```bash
npx tsx --test src/overnight/__tests__/consolidate-shadow-sink.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-shadow-sink.ts src/overnight/__tests__/consolidate-shadow-sink.test.ts
git commit -m "$(cat <<'EOF'
feat(overnight): shadow sink writing candidates to JSONL (spec §4.2)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `extractWithoutStoring` on `MemoryClient`

**Files:**
- Modify: `src/memory.js` (add method after `extractFromConversation` around line 180, add named export around line 576)

**Reason:** The shadow stage must call EVO `/extract` with `store_results: false` so EVO returns candidates without also writing them to memory state (which would duplicate what the old 2 AM task already stored at 02:00). The existing `extractFromConversation` always sends `store_results: true` and queues on failure. Shadow mode wants neither: no storage, no queuing.

This is a small surgical addition to existing JavaScript code. No dedicated unit test — the method is trivially a different request body than the existing one, and the shadow-task tests in Task 4 exercise it via a mocked client. Adding test infrastructure to `memory.js` just for this one method would violate the "don't create abstractions for one-time operations" rule in CLAUDE.md.

- [ ] **Step 1: Read the file to find the insertion points**

Use the Read tool to open `src/memory.js` and find:
- The `extractFromConversation` method (around line 166–180) on `MemoryClient`.
- The named export list near the bottom (line 553 onwards, where `export const checkEvoHealth`, `export const extractFromConversation` live).

- [ ] **Step 2: Add the `extractWithoutStoring` method on the `MemoryClient` class**

Using the Edit tool, insert immediately after the closing `}` of `extractFromConversation` (the method that ends around line 180):

Old string (use enough surrounding context to be unique):
```js
    this._queueItem('text', { type: 'extract', conversation, source });
    return { extracted: [], queued: true };
  }

  // --- Media ---
```

New string:
```js
    this._queueItem('text', { type: 'extract', conversation, source });
    return { extracted: [], queued: true };
  }

  /**
   * Call /extract with store_results: false so EVO returns candidates without
   * persisting them. Used by the compound-dream shadow consolidate stage — the
   * Node side validates and writes to a shadow file. On offline or error,
   * returns an empty result with a flag; does NOT queue (queued extracts would
   * be replayed by the live bot and double-store).
   * @param {string} conversation
   * @param {string} source
   * @returns {Promise<{extracted: Array<object>, offline?: boolean, error?: string}>}
   */
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

  // --- Media ---
```

- [ ] **Step 3: Add the named export**

Using the Edit tool, add a new export line right after the existing `extractFromConversation` export.

Old string:
```js
export const extractFromConversation = (c, s) => client.extractFromConversation(c, s);
```

New string:
```js
export const extractFromConversation = (c, s) => client.extractFromConversation(c, s);
export const extractWithoutStoring = (c, s) => client.extractWithoutStoring(c, s);
```

- [ ] **Step 4: Verify `memory.js` still parses and imports cleanly**

Run a quick import check with tsx (this loads the module without running anything):

```bash
npx tsx -e "import('./src/memory.js').then(m => console.log('extractWithoutStoring:', typeof m.extractWithoutStoring));"
```

Expected output: `extractWithoutStoring: function`

Note: This may fail with `ANTHROPIC_API_KEY required` on a developer machine that lacks the env file. That's fine — it means the module parsed and started initializing config before failing on a side-effect. The parse itself succeeded. Re-run with a stub env var if you want clean output:

```bash
ANTHROPIC_API_KEY=sk-stub OWNER_JID=1234@s.whatsapp.net npx tsx -e "import('./src/memory.js').then(m => console.log('extractWithoutStoring:', typeof m.extractWithoutStoring));"
```

Expected: `extractWithoutStoring: function`.

- [ ] **Step 5: Commit**

```bash
git add src/memory.js
git commit -m "$(cat <<'EOF'
feat(memory): extractWithoutStoring method for shadow consolidate (spec §4.4)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Shadow task function — `src/overnight/consolidate-shadow-task.ts`

**Files:**
- Create: `src/overnight/consolidate-shadow-task.ts`
- Create: `src/overnight/__tests__/consolidate-shadow-task.test.ts`

**Reason:** This is the top-level task function the scheduler will call. It composes the source synthesizer, the shadow sink, the new `extractWithoutStoring`, and the existing Phase 1 stage infrastructure (`makeConsolidateStage` + `OvernightRunner`) into a single callable with the signature `(todayStr, hours, minutes) => Promise<void>`. Gates on `hours === 2 && minutes === 30` and uses a module-level `lastShadowDate` guard for per-day idempotency, matching the pattern used by `checkOvernightExtraction` in `improvement-cycle.js`.

**Dependency injection:** the task function takes a `deps` parameter defaulting to a factory that builds real clients. Tests pass mock `deps`. No `esmock` needed. This is the "manual dependency injection via constructor params" pattern mandated by CLAUDE.md.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-shadow-task.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkConsolidateShadow,
  resetShadowTaskStateForTests,
  SHADOW_TASK_HOUR,
  SHADOW_TASK_MINUTE,
  type ShadowTaskDeps,
} from '../consolidate-shadow-task.js';
import type { ExtractClient } from '../consolidate-extract.js';
import type { MaintenanceClient, TopicIndexClient } from '../consolidate-maintenance.js';
import { queryEvents } from '../events.js';

describe('overnight/consolidate-shadow-task.checkConsolidateShadow', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let logDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-shadow-task-'));
    overnightDir = join(tmpRoot, 'overnight');
    logDir = join(tmpRoot, 'conversation-logs');
    mkdirSync(logDir);
    resetShadowTaskStateForTests();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: Array<Record<string, unknown>>): void {
    writeFileSync(join(logDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function makeDeps(overrides: Partial<ShadowTaskDeps> = {}): ShadowTaskDeps {
    const extractClient: ExtractClient = {
      extractCandidates: async () => ({
        // Candidates WITHOUT sources — the task should synthesize them.
        candidates: [
          { text: 'candidate one', category: 'project', confidence: 0.9 },
          { text: 'candidate two', category: 'note', confidence: 0.8 },
        ],
      }),
    };
    const memoryClient: MaintenanceClient = {
      triggerMaintenance: async () => ({ expired: 1, deduplicated: 0, total_after: 42 }),
    };
    const topicClient: TopicIndexClient = {
      indexDayTopics: async () => 3,
      pruneTopicIndex: async () => 1,
    };
    return {
      overnightDir,
      logDir,
      repoRoot: tmpRoot,
      extractClient,
      memoryClient,
      topicClient,
      ...overrides,
    };
  }

  it('does nothing when the current time is not exactly 02:30', async () => {
    await checkConsolidateShadow('2026-04-10', 1, 59, makeDeps());
    await checkConsolidateShadow('2026-04-10', 2, 29, makeDeps());
    await checkConsolidateShadow('2026-04-10', 2, 31, makeDeps());
    await checkConsolidateShadow('2026-04-10', 3, 30, makeDeps());

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    assert.equal(events.length, 0);
    assert.ok(!existsSync(join(overnightDir, 'shadow-candidates-2026-04-10.jsonl')));
  });

  it('runs the stage when hours === 2 and minutes === 30', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'A valid conversation that is long enough to be processed by the stage' },
      { sender: 'Clint', text: 'Responding with something long enough to pass the length check', isBot: true },
    ]);

    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());

    // Events written
    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    const phases = events.map((e) => e.phase).sort();
    assert.deepEqual(phases, ['extract', 'maintenance', 'store']);

    // Shadow file written with both candidates (sources were synthesized)
    const shadowFile = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    assert.ok(existsSync(shadowFile));
    const lines = readFileSync(shadowFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).candidate.text, 'candidate one');
    // Synthesized source is present and well-formed
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.candidate.sources.length, 1);
    assert.ok(parsed.candidate.sources[0].hash.startsWith('sha256:conv:'));
  });

  it('runs only once per day even if called at 02:30 multiple times', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'Conversation content long enough to pass the minimum length check' },
      { sender: 'Clint', text: 'Another line with enough text to keep the conversation going', isBot: true },
    ]);

    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());
    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());
    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    // 3 events per run, should only see one run
    assert.equal(events.length, 3);

    const shadowFile = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    const lines = readFileSync(shadowFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  });

  it('does not throw when the memory client is offline', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'A valid conversation that is long enough to be processed by the stage' },
      { sender: 'Clint', text: 'Responding with something long enough to pass the length check', isBot: true },
    ]);

    const failingExtract: ExtractClient = {
      extractCandidates: async () => { throw new Error('EVO X2 offline'); },
    };
    const failingMaintenance: MaintenanceClient = {
      triggerMaintenance: async () => { throw new Error('EVO X2 offline'); },
    };

    await assert.doesNotReject(
      checkConsolidateShadow(
        '2026-04-10',
        SHADOW_TASK_HOUR,
        SHADOW_TASK_MINUTE,
        makeDeps({ extractClient: failingExtract, memoryClient: failingMaintenance }),
      ),
    );

    // Events should still be recorded, extract should be 'failed' because errors>0 and files=0
    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    assert.equal(events.length, 3);
    const extract = events.find((e) => e.phase === 'extract');
    assert.ok(extract);
    assert.equal(extract!.verdict, 'failed');
  });

  it('runs again the next day after lastShadowDate rolls over', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'Day one conversation with enough content to pass the length check for real' },
      { sender: 'Clint', text: 'Day one response with enough content to keep it going', isBot: true },
    ]);
    writeLog('2026-04-10-1.jsonl', [
      { sender: 'James', text: 'Day two conversation with enough content to pass the length check for real' },
      { sender: 'Clint', text: 'Day two response with enough content to keep it going', isBot: true },
    ]);

    await checkConsolidateShadow('2026-04-10', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());
    await checkConsolidateShadow('2026-04-11', SHADOW_TASK_HOUR, SHADOW_TASK_MINUTE, makeDeps());

    assert.ok(existsSync(join(overnightDir, 'shadow-candidates-2026-04-10.jsonl')));
    assert.ok(existsSync(join(overnightDir, 'shadow-candidates-2026-04-11.jsonl')));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx tsx --test src/overnight/__tests__/consolidate-shadow-task.test.ts
```

Expected: FAIL with module-not-found on `../consolidate-shadow-task.js`.

- [ ] **Step 3: Implement `src/overnight/consolidate-shadow-task.ts`**

Create `src/overnight/consolidate-shadow-task.ts`:

```ts
// src/overnight/consolidate-shadow-task.ts — scheduler-invoked shadow consolidate task.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.3.
//
// Top-level task function called by src/scheduler.js on its 60-second tick.
// Gates on 02:30 London and a per-day `lastShadowDate` guard so the stage
// runs exactly once per night even if the scheduler tick lands on 02:30
// multiple times (unlikely) or the bot restarts mid-minute.
//
// Dependency injection: the function accepts a `deps` parameter with all
// external clients. In production the factory builds real clients from
// memory.js / topic-index.js. In tests, mocks are passed directly.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OvernightRunner } from './runner.js';
import { makeConsolidateStage } from './consolidate.js';
import { ShadowSink } from './consolidate-shadow-sink.js';
import { synthesizeSources } from './consolidate-source-synthesizer.js';
import type { ExtractClient } from './consolidate-extract.js';
import type { MaintenanceClient, TopicIndexClient } from './consolidate-maintenance.js';
import type { MemoryCandidate } from './consolidate-validate.js';

/** London hour the task fires. */
export const SHADOW_TASK_HOUR = 2;
/** London minute the task fires (30 min after old 2 AM task). */
export const SHADOW_TASK_MINUTE = 30;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(DEFAULT_REPO_ROOT, 'data', 'overnight');
const DEFAULT_LOG_DIR = join(DEFAULT_REPO_ROOT, 'data', 'conversation-logs');

/** Module-level idempotency guard: one run per YYYY-MM-DD. */
let lastShadowDate: string | null = null;

/** Reset guard state. Test-only. */
export function resetShadowTaskStateForTests(): void {
  lastShadowDate = null;
}

export interface ShadowTaskDeps {
  overnightDir: string;
  logDir: string;
  repoRoot: string;
  extractClient: ExtractClient;
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
}

/**
 * Build a default deps object for production use. Imports memory.js and
 * topic-index.js lazily so tests that inject deps don't pay the cost of
 * loading them (and don't trip config validation on missing env vars).
 */
async function buildDefaultDeps(): Promise<ShadowTaskDeps> {
  const { extractWithoutStoring, triggerMaintenance } = await import('../memory.js');
  const { indexDayTopics, pruneTopicIndex } = await import('../topic-index.js');

  const extractClient: ExtractClient = {
    extractCandidates: async (conversation, source) => {
      const resp = await extractWithoutStoring(conversation, source);
      const raw = (resp?.extracted ?? []) as unknown[];
      // Attach synthetic sources so the Phase 1 validator passes during shadow mode.
      const candidates = raw.map((item) => {
        const base = item as Partial<MemoryCandidate>;
        return {
          ...base,
          sources: synthesizeSources(conversation),
        } as MemoryCandidate;
      });
      return { candidates };
    },
  };

  const memoryClient: MaintenanceClient = {
    triggerMaintenance: async () => {
      const r = await triggerMaintenance();
      if (!r || r.error) {
        throw new Error(r?.error ?? 'triggerMaintenance returned null');
      }
      return {
        expired: r.expired ?? 0,
        deduplicated: r.deduplicated ?? 0,
        total_after: r.total_after ?? 0,
      };
    },
  };

  const topicClient: TopicIndexClient = {
    indexDayTopics: async (d) => indexDayTopics(d),
    pruneTopicIndex: async (days) => {
      const n = pruneTopicIndex(days);
      return typeof n === 'number' ? n : 0;
    },
  };

  return {
    overnightDir: DEFAULT_OVERNIGHT_DIR,
    logDir: DEFAULT_LOG_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
    extractClient,
    memoryClient,
    topicClient,
  };
}

/** Given today's YYYY-MM-DD, return yesterday's. UTC noon anchor avoids DST drift. */
function yesterdayFor(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Scheduler-invoked shadow consolidate task. Runs once per day at 02:30 London.
 * Writes events to data/overnight/events-<todayStr>.jsonl and validated
 * candidates to data/overnight/shadow-candidates-<todayStr>.jsonl.
 */
export async function checkConsolidateShadow(
  todayStr: string,
  hours: number,
  minutes: number,
  deps?: ShadowTaskDeps,
): Promise<void> {
  if (hours !== SHADOW_TASK_HOUR || minutes !== SHADOW_TASK_MINUTE) return;
  if (lastShadowDate === todayStr) return;
  lastShadowDate = todayStr;

  const resolvedDeps = deps ?? (await buildDefaultDeps());

  const shadowSink = new ShadowSink({
    overnightDir: resolvedDeps.overnightDir,
    todayStr,
  });

  const stage = makeConsolidateStage({
    logDir: resolvedDeps.logDir,
    extractClient: resolvedDeps.extractClient,
    storeClient: shadowSink,
    memoryClient: resolvedDeps.memoryClient,
    topicClient: resolvedDeps.topicClient,
    yesterdayFor,
  });

  const runner = new OvernightRunner({
    mode: 'cheap',
    date: todayStr,
    overnightDir: resolvedDeps.overnightDir,
    repoRoot: resolvedDeps.repoRoot,
    skipJanitor: true, // in-process: nothing to clean
  });
  runner.register('consolidate', stage);
  await runner.run(['consolidate']);
}
```

- [ ] **Step 4: Run tests and confirm pass**

```bash
npx tsx --test src/overnight/__tests__/consolidate-shadow-task.test.ts
```

Expected: 5 passing tests.

If the "does not throw when the memory client is offline" test fails because the failing extractClient causes the stage to throw: the failure path needs to be verified against the actual `ConsolidateExtractor.extractForDate` implementation, which catches per-file errors into `result.errors`. If the failure surfaces differently, adjust the test's assertions — do NOT add error handling to the task function to mask real failures. The `OvernightRunner` already catches thrown stage errors and writes synthetic failed events (runner.ts line 107). A stage-level throw IS acceptable behavior.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-shadow-task.ts src/overnight/__tests__/consolidate-shadow-task.test.ts
git commit -m "$(cat <<'EOF'
feat(overnight): shadow consolidate task for 02:30 scheduler hook (spec §4.3)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Scheduler wiring — `src/scheduler.js`

**Files:**
- Modify: `src/scheduler.js` (add import line ~18, add runTask call after `overnightExtraction` around line 94)

**Reason:** One new `runTask` entry in `runScheduler` invokes the shadow task every 60-second tick. The existing `runTask` wrapper already handles error containment and logging; the shadow task's own gate rejects non-02:30 ticks. This is a two-line code change plus the import.

No unit test — `src/scheduler.js` is plain JavaScript with module-level state and no existing test coverage. The new line is trivial delegation (matches the pattern of all other runTask calls in the same function), and the task function it calls is already tested. Verification happens via Task 6 deploy smoke test.

- [ ] **Step 1: Read `src/scheduler.js` to locate the exact import block and runTask call list**

Use the Read tool on `src/scheduler.js` lines 1–110.

- [ ] **Step 2: Add the import**

Using Edit, modify the imports block. Find the exact existing import group for the `./tasks/improvement-cycle.js` module and add a new import line on its own.

Old string (this is the existing import block, use it verbatim for uniqueness):
```js
import { checkTraceAnalysis, getLastAnalysisDate } from './tasks/trace-analyser.js';
```

New string:
```js
import { checkTraceAnalysis, getLastAnalysisDate } from './tasks/trace-analyser.js';
import { checkConsolidateShadow } from './overnight/consolidate-shadow-task.js';
```

Note: `tsx` resolves `.js` imports that resolve to `.ts` files, so the `.js` extension here is correct even though the source file is TypeScript.

- [ ] **Step 3: Add the runTask call**

Using Edit, find the `runTask` call for `overnightExtraction` in `runScheduler` and insert the new call immediately after it.

Old string:
```js
  await runTask('overnightExtraction', () => checkOvernightExtraction(todayStr, hours));
```

New string:
```js
  await runTask('overnightExtraction', () => checkOvernightExtraction(todayStr, hours));
  await runTask('consolidateShadow', () => checkConsolidateShadow(todayStr, hours, minutes));
```

- [ ] **Step 4: Verify the scheduler still parses**

Run a quick import check:

```bash
ANTHROPIC_API_KEY=sk-stub OWNER_JID=1234@s.whatsapp.net npx tsx -e "import('./src/scheduler.js').then(m => console.log('initScheduler:', typeof m.initScheduler));"
```

Expected: `initScheduler: function`. If this fails with a module-resolution error on `consolidate-shadow-task.js`, the `.ts` extension was written as `.ts` instead of `.js` on the import. Fix and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.js
git commit -m "$(cat <<'EOF'
feat(scheduler): wire consolidateShadow task at 02:30 London (spec §4.5)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full verification + deploy

**Files:** none modified.

**Reason:** Confirm all new tests pass, the full suite is at-or-above baseline, and the scheduler wiring survives bot startup on EVO before the first shadow night.

- [ ] **Step 1: Run the shadow-mode test subset**

```bash
npx tsx --test src/overnight/__tests__/consolidate-source-synthesizer.test.ts src/overnight/__tests__/consolidate-shadow-sink.test.ts src/overnight/__tests__/consolidate-shadow-task.test.ts
```

Expected: 15 passing tests (6 synthesizer + 4 sink + 5 task).

- [ ] **Step 2: Run the full Phase 1 test suite**

```bash
npx tsx --test src/overnight/__tests__/consolidate*.test.ts
```

Expected: **all Phase 1 consolidate tests pass** (the 28 from the original Phase 1 + 15 new = 43 tests).

- [ ] **Step 3: Run the project's full `npm test`**

```bash
npm test
```

Expected: 508 pass / 2 fail / 1 skipped — the exact Phase 0 baseline. The 2 pre-existing failures carry over. No new failures. (The overnight tests live in `src/overnight/__tests__/` and are outside the `test/*.test.js` glob, so `npm test` count is unchanged — same as Phase 1 itself.)

- [ ] **Step 4: Push and deploy to EVO**

```bash
git push origin main
ssh james@100.90.66.54 'cd ~/clawdbot && git pull && sudo systemctl restart clawdbot && sleep 3 && sudo systemctl is-active clawdbot'
```

Expected: `active`. Bot restarted cleanly with the new task registered.

- [ ] **Step 5: Verify the scheduler picked up the new task**

SSH to EVO and tail the bot log for the next scheduler tick:

```bash
ssh james@100.90.66.54 'sudo journalctl -u clawdbot --since "2 minutes ago" 2>&1 | grep -i "scheduler\|consolidateShadow\|evoHealth" | tail -20'
```

Expected: at least one line mentioning scheduler activity. There will not be any `consolidateShadow` log lines yet — the task only fires at 02:30, and the `runTask` wrapper only logs on errors. If `sudo journalctl` shows no scheduler errors in the last 2 minutes, the wiring is healthy.

- [ ] **Step 6: Check the next morning's output (manual, not automated)**

At some point after 02:30 London on the night following deploy, SSH to EVO and inspect:

```bash
ssh james@100.90.66.54 'ls -la ~/clawdbot/data/overnight/ | grep "2026-"'
ssh james@100.90.66.54 'cat ~/clawdbot/data/overnight/events-$(date +%Y-%m-%d).jsonl 2>&1 | grep consolidate'
ssh james@100.90.66.54 'wc -l ~/clawdbot/data/overnight/shadow-candidates-$(date +%Y-%m-%d).jsonl 2>&1'
```

Expected:
- `shadow-candidates-<today>.jsonl` exists with one or more lines.
- `events-<today>.jsonl` contains three `stage: consolidate` entries (`phase: extract`, `phase: store`, `phase: maintenance`).
- The old `checkOvernightExtraction` at 02:00 ran as normal (visible in the bot's extraction log — not in the new event log).

If the shadow file has zero lines on night 1, diagnose before night 2 rather than letting three nights of empty data accumulate. Likely culprits: EVO `/extract` is returning candidates in a different shape than `resp.extracted`, the conversation log format has drifted, or the memory client was offline during the specific minute the task fired.

- [ ] **Step 7: Phase 1 shadow-mode marker commit**

After confirming the first shadow file is non-empty and well-formed:

```bash
git commit --allow-empty -m "$(cat <<'EOF'
chore(overnight): Phase 1 shadow mode live (spec shadow-mode addendum)

Spec:  docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md
Plan:  docs/superpowers/plans/2026-04-10-compound-dream-phase1-shadow-mode.md

New checkConsolidateShadow task wired at 02:30 London via src/scheduler.js.
Writes validated candidates with synthesized sources to
data/overnight/shadow-candidates-<date>.jsonl. Old 2 AM task untouched.
Three-night soak → manual parity review → cutover commit (separate).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Out-of-band notes for the executing agent

1. **DO NOT touch `src/tasks/improvement-cycle.js` in this plan.** The old 02:00 task stays unchanged throughout the soak. Any "cleanup" is Phase 5 scope creep.

2. **DO NOT modify the cutover behavior during implementation.** This plan ships the shadow infrastructure only. The cutover commit (swap `ShadowSink` for real `storeMemory`, disable old task) is a separate deferred task after three nights of user review.

3. **The `extractWithoutStoring` method deliberately does NOT queue on failure.** Queuing is correct for the live bot's path (the queue is drained when EVO recovers and stores the items). For shadow mode, a queued extract that later runs would double-store the candidate the old path already stored. Return an empty result with a flag and let the stage record the failure as an event.

4. **Synthesized sources are symbolic.** They say "this candidate came from this conversation" at a conversation level, not "this candidate came from line 47". The Phase 1 invariant as written in the spec's §4.1 is strictly weaker during shadow mode. The cutover commit should remove the synthesizer step and rely on EVO emitting real sources — if EVO has not been updated by then, the cutover itself is blocked and raised as a separate pre-cutover task.

5. **`node --test` vs `tsx --test`:** After Phase 0, `npm test` is `tsx --test test/*.test.js`. Do NOT revert it. Overnight tests use `npx tsx --test` directly against their paths and are not picked up by `npm test` — the 508 baseline is expected to stay at 508, not rise to 523. This was a source of confusion in the original Phase 1 plan execution.

6. **Windows git stash quirk** (Phase 0 finding): if stashing mid-task on a Windows clone, do NOT use `git stash push -u`. Untracked-directory removal fails on empty `.cursor/`, `data/topic-index/`, `tests/` dirs. Use `git stash push` without `-u`.

7. **The scheduler import uses `.js` extension** even though the source file is `.ts`. This is correct: `tsx` rewrites `.js` imports to resolve `.ts` files during execution. Do not "fix" it to `.ts` — it will break.

8. **The default-deps builder is lazy** (`async function buildDefaultDeps` with dynamic imports). This is deliberate: it means the test file can import `checkConsolidateShadow` without triggering `src/memory.js` config validation. If you make it eager, tests start failing with `ANTHROPIC_API_KEY required`.

9. **`resetShadowTaskStateForTests` is a test-only export** clearly named. Do NOT refactor it into a class with a reset method — the module-level `lastShadowDate` pattern matches the existing `improvement-cycle.js` idiom (`lastExtractionDate`), and adding a class just for resettability is scope creep per CLAUDE.md.

---

## Plan self-review

**1. Spec coverage:** Every section of the shadow-mode addendum maps to a task:
- §3 Design overview → Tasks 4 + 5 (task function + scheduler wiring)
- §4.1 Source synthesizer → Task 1
- §4.2 Shadow sink → Task 2
- §4.3 Shadow task → Task 4
- §4.4 `extractWithoutStoring` → Task 3
- §4.5 Scheduler line → Task 5
- §5 Data flow → verified end-to-end by Task 4's integration test and Task 6 smoke
- §6 Error handling → covered by Task 4 test "does not throw when memory client offline"
- §7 Testing → all three test files covered across Tasks 1, 2, 4
- §8 Cutover criteria → explicitly deferred (Task 6 Step 6 + out-of-band note 2)
- §9 Untouched files → listed in "Deliberately NOT modified"
- §10 Out of scope → listed in plan header
- §11 Success criteria → verified in Task 6

No gaps.

**2. Placeholder scan:** No TBDs, no "fill in later", no "add appropriate error handling". All test code is complete. All implementation code is complete. All commands have exact expected output.

**3. Type consistency:**
- `MemorySource`, `MemoryCandidate`, `MAX_EXCERPT_CHARS` all imported from `consolidate-validate.ts` (existing Phase 1 exports) — names match.
- `StoreClient`, `ConsolidateStore` imported from `consolidate-store.ts` (existing Phase 1 exports) — names match.
- `ExtractClient` imported from `consolidate-extract.ts`, `MaintenanceClient` / `TopicIndexClient` from `consolidate-maintenance.ts`, `makeConsolidateStage` from `consolidate.ts`, `OvernightRunner` from `runner.ts` — all existing Phase 1 exports, names match.
- `checkConsolidateShadow`, `SHADOW_TASK_HOUR`, `SHADOW_TASK_MINUTE`, `resetShadowTaskStateForTests`, `ShadowTaskDeps`, `ShadowSink`, `synthesizeSources`, `SYNTHETIC_HASH_PREFIX` — all defined in the tasks that use them.
- `extractWithoutStoring` defined in Task 3, consumed in Task 4's default-deps builder.

No mismatches.

**4. CLAUDE.md compliance spot-check:**
- File sizes: synthesizer ~35 lines, sink ~50, shadow-task ~140. All under 300.
- Classes for stateful services: ShadowSink is a class (has file state and a dirEnsured flag). synthesizeSources is a pure function. ✓
- Manual DI: ShadowSink takes opts in constructor, checkConsolidateShadow takes deps as default parameter, no singletons imported by the task function directly. ✓
- No silent failures: the task function lets OvernightRunner's error capture do its job; `extractWithoutStoring` explicitly returns `{offline: true}` or `{error: msg}` rather than swallowing. ✓
- TypeScript strict, no `any`: all types named, `unknown[]` where EVO returns untyped data then mapped through a typed shape. ✓
- No magic numbers: `SHADOW_TASK_HOUR`, `SHADOW_TASK_MINUTE`, `MAX_EXCERPT_CHARS` (reused), `SYNTHETIC_HASH_PREFIX` all named constants. ✓
- Dispatch over if/else: no conditional chains introduced. ✓

---

## Next-phase handoff

After this plan + the cutover commit, the tree has:

- `checkConsolidateShadow` running nightly at 02:30 inside the bot process
- Three nights of `shadow-candidates-<date>.jsonl` files on EVO for manual parity review
- A one-commit cutover path that swaps `ShadowSink` → real `storeMemory` and disables `checkOvernightExtraction`
- Zero modifications to `src/tasks/improvement-cycle.js` (retirement is Phase 5)

After cutover (separate task, not part of this plan):
- Phase 2 PROBE design + plan
- Phase 3 REPORT design + plan
- Phase 4 IMPROVE design + plan
- Phase 5 Retirement cleanup of the legacy overnight files

*End of Phase 1 shadow-mode plan.*
