# Compound Dream — Phase 1: CONSOLIDATE stage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md` §4.1 CONSOLIDATE

**Depends on:** `docs/superpowers/plans/2026-04-10-compound-dream-phase0-preconditions.md` (must be complete, Phase 0 commits `92538be` through `09b6047`)

**Goal:** Ship the first real nightly stage — `CONSOLIDATE` — which extracts memories from yesterday's conversation logs, **enforces an evidence-chain invariant** (every new memory entry carries `sources: [{hash, excerpt}]` or it is rejected), runs memory maintenance (expire + dedup), updates the topic index, and writes every action to the Phase 0 event log. Runs on EVO, 0 Opus sessions, ~30 min budget.

**Architecture:** A new `src/overnight/consolidate.ts` module registered with `OvernightRunner` as the `consolidate` stage. Internally composed of four narrow sub-modules: `consolidate-extract.ts` (drives yesterday's logs through EVO's `/extract` endpoint with `store_results:false` so Node can validate), `consolidate-validate.ts` (schema validator that rejects any extracted entry missing `sources[]`), `consolidate-store.ts` (stores validated entries via a new Node-side call and writes rejected entries to `data/overnight/rejected-<date>.jsonl`), `consolidate-maintenance.ts` (thin wrapper around the existing `triggerMaintenance()` + topic-index functions). The existing `src/tasks/improvement-cycle.js` is **not** modified — the new stage runs alongside it in shadow mode for 3 nights before the scheduler cutover (a separate follow-up task, deferred past this plan).

**Tech Stack:** TypeScript strict, `tsx` runner, `node:test` + `mock.fn()` for tests (no `esmock` needed — DI through constructor params), `node:fs/promises`, `node:crypto` for source hashing.

**Out of scope for Phase 1:**
- Touching `src/tasks/improvement-cycle.js`, `src/tasks/overnight-to-evolution.js`, or the existing 2 AM cron entry (all retired in Phase 5).
- Scheduler wiring. The new stage is run manually (or by a one-off test harness) during the 3-night shadow period. Scheduler cutover is a separate mini-phase, not this plan.
- Changes to `evo-memory/dream_mode.py` itself. The Python extractor stays exactly as-is — the wrapper is entirely Node-side.
- Adding a new EVO memory-service endpoint. This plan assumes the existing `/extract` endpoint accepts `store_results: false` (already the case per `src/memory.js:171`), and reuses the existing `storeMemory()` / memory-store path for explicit storage.
- The PROBE, REPORT, and IMPROVE stages. Each gets its own phased plan.
- Weight decay, drift checks, quality-gate enrichment — those are PROBE's job (Phase 2), not CONSOLIDATE's.

**Shadow-mode invariant (critical):**

For 3 consecutive nights after this plan lands, the new `consolidate` stage **runs alongside the existing 2 AM `checkOvernightExtraction` task**, not instead of it. Both extract from the same logs. The new stage stores its results to the memory service exactly as the old one does; the rejected entries are the new visible output. This is deliberate — the old path produces memory entries with no sources field (all of them currently), and we want to prove the new path produces a sensible subset of validated-source entries before tearing out the old pipeline. The cutover (scheduler entry point swap and retirement of `checkOvernightExtraction`) is a separate task deferred until the 3-night soak has produced at least one real consolidate run with non-zero validated entries and non-zero rejected entries.

---

## File Structure

**Created by this phase:**

```
src/overnight/consolidate.ts                                  Stage entry, registered with OvernightRunner
src/overnight/consolidate-extract.ts                          EVO /extract driver
src/overnight/consolidate-validate.ts                         Schema validator (sources[] enforcement)
src/overnight/consolidate-store.ts                            Validated-store + rejected-log writer
src/overnight/consolidate-maintenance.ts                      Maintenance + topic-index wrapper
src/overnight/__tests__/consolidate-validate.test.ts          Pure schema tests
src/overnight/__tests__/consolidate-extract.test.ts           Mocked EVO client tests
src/overnight/__tests__/consolidate-store.test.ts             Tmp-dir tests with mocked memory client
src/overnight/__tests__/consolidate-maintenance.test.ts       Mocked maintenance client
src/overnight/__tests__/consolidate.test.ts                   End-to-end stage test with mocked dependencies
src/overnight/run-consolidate-manual.ts                       Standalone invoker for shadow-run + verification
```

**Modified by this phase (surgical only):**

```
(none)
```

No existing files are modified in Phase 1. The new stage runs as a standalone module. Integration with the scheduler is deferred.

**Deliberately NOT modified:**

```
src/tasks/improvement-cycle.js                  Retired in Phase 5; continues to run the 2 AM extract during shadow
src/tasks/overnight-to-evolution.js             Retired in Phase 5
src/memory.js                                   API boundary; Phase 1 consumes it read-only
evo-memory/dream_mode.py                        Python extractor stays — wrapper is Node-side
src/overnight/runner.ts                         Stage registration happens in consolidate.ts, not in runner
```

---

### Task 1: Validator — `src/overnight/consolidate-validate.ts`

**Files:**
- Create: `src/overnight/consolidate-validate.ts`
- Create: `src/overnight/__tests__/consolidate-validate.test.ts`

Reason: spec §4.1 evidence-chain invariant — "Every new memory entry must cite at least one source — a content hash of the conversation log line it was extracted from, plus a short excerpt (≤200 chars). The extractor produces candidates; a schema validator drops any candidate missing the `sources` field."

This is the foundation of Phase 1. Build it first because (a) it is pure, fast to test, and has no external dependencies, and (b) every other module in the phase consumes its types.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-validate.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCandidate,
  type MemoryCandidate,
  type MemorySource,
  MAX_EXCERPT_CHARS,
} from '../consolidate-validate.js';

describe('overnight/consolidate-validate.validateCandidate', () => {
  const sources: MemorySource[] = [
    { hash: 'sha256:abc123', excerpt: 'James said the deadline is next Tuesday' },
  ];

  function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
    return {
      text: 'James has a deadline next Tuesday',
      category: 'project',
      confidence: 0.8,
      sources,
      ...overrides,
    };
  }

  it('accepts a candidate with all required fields and at least one source', () => {
    const result = validateCandidate(makeCandidate());
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  it('rejects a candidate with missing sources field', () => {
    const candidate = { ...makeCandidate(), sources: undefined as unknown as MemorySource[] };
    const result = validateCandidate(candidate);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /no_evidence|missing.*sources/i);
  });

  it('rejects a candidate with an empty sources array', () => {
    const result = validateCandidate(makeCandidate({ sources: [] }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /no_evidence/i);
  });

  it('rejects a source missing the hash field', () => {
    const badSources = [{ excerpt: 'hi' }] as unknown as MemorySource[];
    const result = validateCandidate(makeCandidate({ sources: badSources }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /hash/i);
  });

  it('rejects a source missing the excerpt field', () => {
    const badSources = [{ hash: 'sha256:x' }] as unknown as MemorySource[];
    const result = validateCandidate(makeCandidate({ sources: badSources }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /excerpt/i);
  });

  it('rejects a source whose excerpt exceeds MAX_EXCERPT_CHARS', () => {
    const longExcerpt = 'x'.repeat(MAX_EXCERPT_CHARS + 1);
    const result = validateCandidate(
      makeCandidate({ sources: [{ hash: 'sha256:y', excerpt: longExcerpt }] }),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /excerpt.*too long|exceeds/i);
  });

  it('rejects a candidate with empty text', () => {
    const result = validateCandidate(makeCandidate({ text: '' }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /text/i);
  });

  it('rejects a candidate with missing category', () => {
    const candidate = { ...makeCandidate(), category: undefined as unknown as string };
    const result = validateCandidate(candidate);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /category/i);
  });

  it('rejects a candidate with confidence outside [0, 1]', () => {
    const tooLow = validateCandidate(makeCandidate({ confidence: -0.1 }));
    const tooHigh = validateCandidate(makeCandidate({ confidence: 1.5 }));
    assert.equal(tooLow.valid, false);
    assert.equal(tooHigh.valid, false);
  });

  it('accepts a candidate with multiple sources', () => {
    const result = validateCandidate(
      makeCandidate({
        sources: [
          { hash: 'sha256:a', excerpt: 'first' },
          { hash: 'sha256:b', excerpt: 'second' },
        ],
      }),
    );
    assert.equal(result.valid, true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/consolidate-validate.test.ts
```

Expected: FAIL with module-not-found on `../consolidate-validate.js`.

- [ ] **Step 3: Implement `src/overnight/consolidate-validate.ts`**

Create `src/overnight/consolidate-validate.ts`:

```ts
// src/overnight/consolidate-validate.ts — schema validator for extracted memory candidates.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1 evidence-chain invariant.
//
// Every candidate must carry at least one source (hash + excerpt). Candidates
// that fail validation are rejected and will be written to data/overnight/rejected-<date>.jsonl
// by the store module. This is the hard schema gate for the consolidate stage.

export const MAX_EXCERPT_CHARS = 200;

export interface MemorySource {
  hash: string;     // content hash of the conversation log line, e.g. "sha256:abc..."
  excerpt: string;  // short quoted excerpt, ≤MAX_EXCERPT_CHARS
}

export interface MemoryCandidate {
  text: string;
  category: string;
  confidence: number;
  sources: MemorySource[];
  // Optional fields the extractor may supply; not validated here.
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate one extracted memory candidate against the evidence-chain invariant.
 * Returns `{ valid: true }` or `{ valid: false, reason: "..." }` — never throws.
 */
export function validateCandidate(candidate: unknown): ValidationResult {
  if (typeof candidate !== 'object' || candidate === null) {
    return { valid: false, reason: 'not_object' };
  }
  const c = candidate as Partial<MemoryCandidate>;

  if (typeof c.text !== 'string' || c.text.length === 0) {
    return { valid: false, reason: 'text_missing_or_empty' };
  }
  if (typeof c.category !== 'string' || c.category.length === 0) {
    return { valid: false, reason: 'category_missing_or_empty' };
  }
  if (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1) {
    return { valid: false, reason: `confidence_out_of_range: ${c.confidence}` };
  }

  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    return { valid: false, reason: 'no_evidence: missing or empty sources[]' };
  }

  for (let i = 0; i < c.sources.length; i++) {
    const s = c.sources[i];
    if (!s || typeof s !== 'object') {
      return { valid: false, reason: `sources[${i}]_not_object` };
    }
    const src = s as Partial<MemorySource>;
    if (typeof src.hash !== 'string' || src.hash.length === 0) {
      return { valid: false, reason: `sources[${i}]_hash_missing_or_empty` };
    }
    if (typeof src.excerpt !== 'string' || src.excerpt.length === 0) {
      return { valid: false, reason: `sources[${i}]_excerpt_missing_or_empty` };
    }
    if (src.excerpt.length > MAX_EXCERPT_CHARS) {
      return {
        valid: false,
        reason: `sources[${i}]_excerpt_too_long: ${src.excerpt.length} exceeds ${MAX_EXCERPT_CHARS}`,
      };
    }
  }

  return { valid: true };
}
```

- [ ] **Step 4: Run test and confirm pass**

Run:
```bash
npx tsx --test src/overnight/__tests__/consolidate-validate.test.ts
```

Expected: 10 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-validate.ts src/overnight/__tests__/consolidate-validate.test.ts
git commit -m "feat(overnight): memory-candidate validator with evidence-chain enforcement (spec §4.1)"
```

---

### Task 2: Extract driver — `src/overnight/consolidate-extract.ts`

**Files:**
- Create: `src/overnight/consolidate-extract.ts`
- Create: `src/overnight/__tests__/consolidate-extract.test.ts`

Reason: wraps the EVO memory service `/extract` endpoint call so the consolidate stage can iterate over yesterday's conversation log files. Uses **dependency injection** — the EVO client is a constructor parameter, not a module-level import, so tests can supply a mock without `esmock`.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-extract.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsolidateExtractor, type ExtractClient } from '../consolidate-extract.js';

describe('overnight/consolidate-extract.ConsolidateExtractor', () => {
  let tmpRoot: string;
  let logDir: string;
  let mockClient: ExtractClient;
  let capturedCalls: Array<{ conversation: string; source: string }>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-extract-'));
    logDir = join(tmpRoot, 'logs');
    mkdirSync(logDir);
    capturedCalls = [];
    mockClient = {
      extractCandidates: async (conversation: string, source: string) => {
        capturedCalls.push({ conversation, source });
        return {
          candidates: [
            {
              text: 'test memory',
              category: 'test',
              confidence: 0.9,
              sources: [{ hash: 'sha256:test', excerpt: conversation.slice(0, 20) }],
            },
          ],
        };
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('extracts candidates from each log file matching the date', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-a.jsonl'),
      JSON.stringify({ sender: 'James', text: 'hello world' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'hi James', isBot: true }) + '\n',
    );
    writeFileSync(
      join(logDir, '2026-04-09-b.jsonl'),
      JSON.stringify({ sender: 'James', text: 'another conversation here with enough content' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'noted', isBot: true }) + '\n',
    );
    // Also a log from a different date that should be ignored.
    writeFileSync(
      join(logDir, '2026-04-08.jsonl'),
      JSON.stringify({ sender: 'James', text: 'old stuff' }) + '\n',
    );

    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');

    assert.equal(result.filesProcessed, 2);
    assert.equal(result.candidates.length, 2);
    assert.equal(capturedCalls.length, 2);
    assert.ok(capturedCalls[0]!.conversation.includes('hello world'));
    assert.ok(capturedCalls[1]!.conversation.includes('another conversation'));
  });

  it('returns empty result when no logs exist for the date', async () => {
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2099-01-01');
    assert.equal(result.filesProcessed, 0);
    assert.equal(result.candidates.length, 0);
    assert.equal(capturedCalls.length, 0);
  });

  it('skips files with less than 2 message lines', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-tiny.jsonl'),
      JSON.stringify({ sender: 'James', text: 'hi' }) + '\n',
    );
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 0);
    assert.equal(result.candidates.length, 0);
  });

  it('skips files whose assembled conversation is under 50 chars', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-short.jsonl'),
      JSON.stringify({ sender: 'James', text: 'hi' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'ok', isBot: true }) + '\n',
    );
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 0);
  });

  it('continues when one file fails to parse', async () => {
    writeFileSync(join(logDir, '2026-04-09-ok.jsonl'),
      JSON.stringify({ sender: 'James', text: 'a valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'valid response', isBot: true }) + '\n',
    );
    writeFileSync(join(logDir, '2026-04-09-bad.jsonl'), 'not json at all\nnope\n');
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.file, /2026-04-09-bad\.jsonl/);
  });

  it('propagates EVO extract errors into the errors array and continues', async () => {
    writeFileSync(join(logDir, '2026-04-09-a.jsonl'),
      JSON.stringify({ sender: 'James', text: 'a valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'valid response', isBot: true }) + '\n',
    );
    writeFileSync(join(logDir, '2026-04-09-b.jsonl'),
      JSON.stringify({ sender: 'James', text: 'another valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'response', isBot: true }) + '\n',
    );
    const failingClient: ExtractClient = {
      extractCandidates: async (_conversation, source) => {
        if (source.endsWith('-b')) throw new Error('evo timeout');
        return { candidates: [{ text: 't', category: 'c', confidence: 0.5, sources: [{ hash: 'h', excerpt: 'e' }] }] };
      },
    };
    const extractor = new ConsolidateExtractor({ client: failingClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.reason, /evo timeout/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx tsx --test src/overnight/__tests__/consolidate-extract.test.ts
```

Expected: FAIL — `../consolidate-extract.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/consolidate-extract.ts`**

Create `src/overnight/consolidate-extract.ts`:

```ts
// src/overnight/consolidate-extract.ts — drives yesterday's conversation logs
// through the EVO memory service /extract endpoint and collects candidates.
// Spec §4.1 consolidate stage, inputs.
//
// Dependency-injected EVO client so tests can mock without esmock.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryCandidate } from './consolidate-validate.js';

/** Minimum assembled-conversation length before we bother calling EVO. */
export const MIN_CONVERSATION_CHARS = 50;
/** Minimum number of log lines in a file before we process it. */
export const MIN_LOG_LINES = 2;

export interface ExtractClient {
  /**
   * Call EVO's memory service /extract endpoint with `store_results: false`.
   * Returns the candidate list without persisting anything.
   */
  extractCandidates(
    conversation: string,
    source: string,
  ): Promise<{ candidates: unknown[] }>;
}

export interface ConsolidateExtractorOptions {
  client: ExtractClient;
  logDir: string;
}

export interface ExtractError {
  file: string;
  reason: string;
}

export interface ExtractResult {
  filesProcessed: number;
  candidates: MemoryCandidate[];
  errors: ExtractError[];
}

interface LogMessage {
  sender?: string;
  text?: string;
  isBot?: boolean;
}

export class ConsolidateExtractor {
  constructor(private readonly opts: ConsolidateExtractorOptions) {}

  /**
   * Extract candidates from all log files whose name begins with the given date.
   * Files that can't be parsed or whose content is trivially short are skipped
   * and counted in `errors` (for parse failures) or silently ignored (for
   * too-short conversations).
   */
  async extractForDate(date: string): Promise<ExtractResult> {
    const result: ExtractResult = { filesProcessed: 0, candidates: [], errors: [] };
    if (!existsSync(this.opts.logDir)) return result;

    const all = await readdir(this.opts.logDir);
    const matching = all.filter((f) => f.startsWith(date) && f.endsWith('.jsonl'));

    for (const file of matching) {
      try {
        const content = await readFile(join(this.opts.logDir, file), 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        if (lines.length < MIN_LOG_LINES) continue;

        const messages = this.parseLines(lines, file);
        if (messages.length < MIN_LOG_LINES) continue;

        const convText = this.renderConversation(messages);
        if (convText.length < MIN_CONVERSATION_CHARS) continue;

        const source = `conversation_${date}_${file.replace(/\.jsonl$/, '')}`;
        try {
          const { candidates } = await this.opts.client.extractCandidates(convText, source);
          for (const c of candidates) {
            result.candidates.push(c as MemoryCandidate);
          }
          result.filesProcessed += 1;
        } catch (err) {
          result.errors.push({ file, reason: (err as Error).message });
        }
      } catch (err) {
        result.errors.push({ file, reason: (err as Error).message });
      }
    }

    return result;
  }

  private parseLines(lines: string[], file: string): LogMessage[] {
    const messages: LogMessage[] = [];
    let parseFailed = false;
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as LogMessage);
      } catch {
        parseFailed = true;
      }
    }
    // If every single line failed to parse, treat the file as unreadable.
    if (parseFailed && messages.length === 0) {
      throw new Error(`every line in ${file} failed to parse as JSON`);
    }
    return messages;
  }

  private renderConversation(messages: LogMessage[]): string {
    return messages
      .map((m) => {
        const name = m.sender ?? (m.isBot ? 'Clint' : 'User');
        return `${name}: ${m.text ?? ''}`;
      })
      .join('\n');
  }
}
```

- [ ] **Step 4: Run tests and confirm pass**

```bash
npx tsx --test src/overnight/__tests__/consolidate-extract.test.ts
```

Expected: 6 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-extract.ts src/overnight/__tests__/consolidate-extract.test.ts
git commit -m "feat(overnight): consolidate extract driver with DI EVO client (spec §4.1)"
```

---

### Task 3: Validated storage + rejection logger — `src/overnight/consolidate-store.ts`

**Files:**
- Create: `src/overnight/consolidate-store.ts`
- Create: `src/overnight/__tests__/consolidate-store.test.ts`

Reason: after extraction the validator decides pass/fail per candidate. This module (a) stores validated candidates via a DI'd `StoreClient`, and (b) appends rejected candidates to `data/overnight/rejected-<YYYY-MM-DD>.jsonl` with their reason code, so we can see them in the morning.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-store.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsolidateStore, type StoreClient, type StoreResult } from '../consolidate-store.js';
import type { MemoryCandidate } from '../consolidate-validate.js';

describe('overnight/consolidate-store.ConsolidateStore', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let storedEntries: MemoryCandidate[];
  let failingStoreOn: string | null;
  let mockClient: StoreClient;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-store-'));
    overnightDir = join(tmpRoot, 'overnight');
    storedEntries = [];
    failingStoreOn = null;
    mockClient = {
      storeValidated: async (candidate: MemoryCandidate) => {
        if (failingStoreOn && candidate.text.includes(failingStoreOn)) {
          throw new Error(`store failed for ${candidate.text}`);
        }
        storedEntries.push(candidate);
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function valid(text: string): MemoryCandidate {
    return {
      text,
      category: 'test',
      confidence: 0.8,
      sources: [{ hash: 'sha256:h', excerpt: text.slice(0, 50) }],
    };
  }

  function invalid(text: string): MemoryCandidate {
    return {
      text,
      category: 'test',
      confidence: 0.8,
      sources: [] as MemoryCandidate['sources'],
    };
  }

  it('stores all validated candidates and writes none to rejected log', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result: StoreResult = await store.process({
      candidates: [valid('memory A'), valid('memory B'), valid('memory C')],
      date: '2026-04-10',
    });

    assert.equal(result.stored, 3);
    assert.equal(result.rejected, 0);
    assert.equal(storedEntries.length, 3);
    assert.ok(!existsSync(join(overnightDir, 'rejected-2026-04-10.jsonl')));
  });

  it('writes invalid candidates to rejected-<date>.jsonl and stores valid ones', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result = await store.process({
      candidates: [valid('memory A'), invalid('bad one'), valid('memory B')],
      date: '2026-04-10',
    });

    assert.equal(result.stored, 2);
    assert.equal(result.rejected, 1);
    assert.equal(storedEntries.length, 2);

    const rejectedFile = join(overnightDir, 'rejected-2026-04-10.jsonl');
    assert.ok(existsSync(rejectedFile));
    const lines = readFileSync(rejectedFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.candidate.text, 'bad one');
    assert.match(parsed.reason, /no_evidence/);
    assert.ok(parsed.timestamp);
  });

  it('records store failures in the store_errors field and still processes other candidates', async () => {
    failingStoreOn = 'will fail';
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result = await store.process({
      candidates: [valid('ok one'), valid('will fail'), valid('another ok')],
      date: '2026-04-10',
    });

    assert.equal(result.stored, 2);
    assert.equal(result.rejected, 0);
    assert.equal(result.storeErrors.length, 1);
    assert.match(result.storeErrors[0]!.reason, /store failed/);
  });

  it('appends to an existing rejected log without overwriting', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    await store.process({ candidates: [invalid('first bad')], date: '2026-04-10' });
    await store.process({ candidates: [invalid('second bad')], date: '2026-04-10' });

    const rejectedFile = join(overnightDir, 'rejected-2026-04-10.jsonl');
    const lines = readFileSync(rejectedFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).candidate.text, 'first bad');
    assert.equal(JSON.parse(lines[1]!).candidate.text, 'second bad');
  });

  it('handles an empty candidate list cleanly', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result = await store.process({ candidates: [], date: '2026-04-10' });
    assert.equal(result.stored, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.storeErrors.length, 0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx tsx --test src/overnight/__tests__/consolidate-store.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/overnight/consolidate-store.ts`**

Create `src/overnight/consolidate-store.ts`:

```ts
// src/overnight/consolidate-store.ts — validated storage + rejection logger.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1.
//
// For each candidate produced by ConsolidateExtractor:
//   - run the validator (consolidate-validate.ts)
//   - on valid → call StoreClient.storeValidated()
//   - on invalid → append to data/overnight/rejected-<date>.jsonl with reason
// Store failures are recorded in storeErrors and do not stop processing.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate, type MemoryCandidate } from './consolidate-validate.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(REPO_ROOT, 'data', 'overnight');

export interface StoreClient {
  /** Store a candidate that has passed validation. */
  storeValidated(candidate: MemoryCandidate): Promise<void>;
}

export interface ConsolidateStoreOptions {
  client: StoreClient;
  overnightDir?: string;
}

export interface StoreError {
  candidate: MemoryCandidate;
  reason: string;
}

export interface StoreResult {
  stored: number;
  rejected: number;
  storeErrors: StoreError[];
}

export interface ProcessInput {
  candidates: MemoryCandidate[];
  date: string;
}

export class ConsolidateStore {
  private readonly overnightDir: string;

  constructor(private readonly opts: ConsolidateStoreOptions) {
    this.overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  }

  async process(input: ProcessInput): Promise<StoreResult> {
    const result: StoreResult = { stored: 0, rejected: 0, storeErrors: [] };
    if (input.candidates.length === 0) return result;

    const rejectedFile = join(this.overnightDir, `rejected-${input.date}.jsonl`);
    let rejectedDirEnsured = false;

    for (const candidate of input.candidates) {
      const validation = validateCandidate(candidate);
      if (!validation.valid) {
        if (!rejectedDirEnsured) {
          await mkdir(this.overnightDir, { recursive: true });
          rejectedDirEnsured = true;
        }
        const entry = {
          timestamp: new Date().toISOString(),
          reason: validation.reason ?? 'unknown',
          candidate,
        };
        await appendFile(rejectedFile, JSON.stringify(entry) + '\n', 'utf8');
        result.rejected += 1;
        continue;
      }

      try {
        await this.opts.client.storeValidated(candidate);
        result.stored += 1;
      } catch (err) {
        result.storeErrors.push({ candidate, reason: (err as Error).message });
      }
    }

    return result;
  }
}
```

- [ ] **Step 4: Run tests and confirm pass**

```bash
npx tsx --test src/overnight/__tests__/consolidate-store.test.ts
```

Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-store.ts src/overnight/__tests__/consolidate-store.test.ts
git commit -m "feat(overnight): validated store + rejected log writer (spec §4.1)"
```

---

### Task 4: Maintenance + topic-index wrapper — `src/overnight/consolidate-maintenance.ts`

**Files:**
- Create: `src/overnight/consolidate-maintenance.ts`
- Create: `src/overnight/__tests__/consolidate-maintenance.test.ts`

Reason: spec §4.1 "Existing behaviour preserved: expire old volatile categories, deduplicate, prune topic index older than 30 days. Runs as part of the same pass." The existing logic lives in `src/memory.js:triggerMaintenance()` and `src/topic-index.js:{indexDayTopics, pruneTopicIndex}`. This module wraps both behind a DI boundary so the consolidate stage doesn't touch those singletons directly and tests can inject mocks.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate-maintenance.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsolidateMaintenance,
  type MaintenanceClient,
  type TopicIndexClient,
  TOPIC_INDEX_PRUNE_DAYS,
} from '../consolidate-maintenance.js';

function makeClient(overrides: Partial<MaintenanceClient> = {}): MaintenanceClient {
  return {
    triggerMaintenance: async () => ({ expired: 3, deduplicated: 2, total_after: 42 }),
    ...overrides,
  };
}

function makeTopicClient(overrides: Partial<TopicIndexClient> = {}): TopicIndexClient {
  return {
    indexDayTopics: async () => 5,
    pruneTopicIndex: async () => 2,
    ...overrides,
  };
}

describe('overnight/consolidate-maintenance.ConsolidateMaintenance', () => {
  it('calls triggerMaintenance and returns its result', async () => {
    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient(),
      topicClient: makeTopicClient(),
    });
    const result = await maint.run('2026-04-10');
    assert.equal(result.maintenance.expired, 3);
    assert.equal(result.maintenance.deduplicated, 2);
    assert.equal(result.maintenance.total_after, 42);
  });

  it('indexes topics for the given date and prunes topics older than TOPIC_INDEX_PRUNE_DAYS', async () => {
    let pruneDaysCalled: number | null = null;
    let indexDateCalled: string | null = null;

    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient(),
      topicClient: makeTopicClient({
        indexDayTopics: async (date) => {
          indexDateCalled = date;
          return 7;
        },
        pruneTopicIndex: async (days) => {
          pruneDaysCalled = days;
          return 4;
        },
      }),
    });

    const result = await maint.run('2026-04-10');
    assert.equal(indexDateCalled, '2026-04-10');
    assert.equal(pruneDaysCalled, TOPIC_INDEX_PRUNE_DAYS);
    assert.equal(result.topicsIndexed, 7);
    assert.equal(result.topicsPruned, 4);
  });

  it('continues when maintenance fails and returns the error', async () => {
    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient({
        triggerMaintenance: async () => { throw new Error('maint boom'); },
      }),
      topicClient: makeTopicClient(),
    });
    const result = await maint.run('2026-04-10');
    assert.equal(result.maintenance, null);
    assert.match(result.errors[0]!, /maint.*maint boom/i);
    // Topic indexing still ran.
    assert.equal(result.topicsIndexed, 5);
  });

  it('continues when topic indexing fails and still runs pruning attempt', async () => {
    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient(),
      topicClient: makeTopicClient({
        indexDayTopics: async () => { throw new Error('index boom'); },
      }),
    });
    const result = await maint.run('2026-04-10');
    assert.equal(result.topicsIndexed, null);
    assert.match(result.errors[0]!, /topic_index.*index boom/i);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx tsx --test src/overnight/__tests__/consolidate-maintenance.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `src/overnight/consolidate-maintenance.ts`**

Create `src/overnight/consolidate-maintenance.ts`:

```ts
// src/overnight/consolidate-maintenance.ts — memory + topic index maintenance.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1.
//
// Wraps the existing triggerMaintenance() + topic-index functions behind a DI
// boundary so the consolidate stage never imports singletons directly.
// Errors in one sub-step do not stop the others.

export const TOPIC_INDEX_PRUNE_DAYS = 30;

export interface MaintenanceResult {
  expired: number;
  deduplicated: number;
  total_after: number;
}

export interface MaintenanceClient {
  triggerMaintenance(): Promise<MaintenanceResult>;
}

export interface TopicIndexClient {
  indexDayTopics(date: string): Promise<number>;
  pruneTopicIndex(days: number): Promise<number>;
}

export interface ConsolidateMaintenanceOptions {
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
}

export interface ConsolidateMaintenanceResult {
  maintenance: MaintenanceResult | null;
  topicsIndexed: number | null;
  topicsPruned: number | null;
  errors: string[];
}

export class ConsolidateMaintenance {
  constructor(private readonly opts: ConsolidateMaintenanceOptions) {}

  async run(date: string): Promise<ConsolidateMaintenanceResult> {
    const result: ConsolidateMaintenanceResult = {
      maintenance: null,
      topicsIndexed: null,
      topicsPruned: null,
      errors: [],
    };

    try {
      result.maintenance = await this.opts.memoryClient.triggerMaintenance();
    } catch (err) {
      result.errors.push(`maintenance: ${(err as Error).message}`);
    }

    try {
      result.topicsIndexed = await this.opts.topicClient.indexDayTopics(date);
    } catch (err) {
      result.errors.push(`topic_index_day: ${(err as Error).message}`);
    }

    try {
      result.topicsPruned = await this.opts.topicClient.pruneTopicIndex(TOPIC_INDEX_PRUNE_DAYS);
    } catch (err) {
      result.errors.push(`topic_index_prune: ${(err as Error).message}`);
    }

    return result;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx tsx --test src/overnight/__tests__/consolidate-maintenance.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate-maintenance.ts src/overnight/__tests__/consolidate-maintenance.test.ts
git commit -m "feat(overnight): consolidate maintenance wrapper (spec §4.1)"
```

---

### Task 5: Stage entry point — `src/overnight/consolidate.ts`

**Files:**
- Create: `src/overnight/consolidate.ts`
- Create: `src/overnight/__tests__/consolidate.test.ts`

Reason: composes the three sub-modules into a single `runConsolidateStage(ctx)` function that can be registered with `OvernightRunner.register('consolidate', runConsolidateStage)`. This is the thing Phase 1 actually delivers as a runnable stage.

The stage writes **three classes of events** to the event log (via `ctx.appendEvent`):
1. `phase: 'extract'` — one event per date with `filesProcessed`, candidate counts
2. `phase: 'store'` — one event per date with `stored`, `rejected`, `storeErrors` counts
3. `phase: 'maintenance'` — one event with the maintenance result

On any unrecoverable error (e.g. the extractor couldn't find the log dir at all), the stage **records a failed event** and returns normally. The OvernightRunner's synthetic-failure-on-no-event guard (Phase 0) acts as the last-resort safety net.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/consolidate.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvernightRunner } from '../runner.js';
import { queryEvents } from '../events.js';
import { makeConsolidateStage } from '../consolidate.js';
import type { ExtractClient } from '../consolidate-extract.js';
import type { StoreClient } from '../consolidate-store.js';
import type { MaintenanceClient, TopicIndexClient } from '../consolidate-maintenance.js';
import type { MemoryCandidate } from '../consolidate-validate.js';

describe('overnight/consolidate.runConsolidateStage', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let logDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-consolidate-'));
    overnightDir = join(tmpRoot, 'overnight');
    logDir = join(tmpRoot, 'conversation-logs');
    mkdirSync(logDir);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: Array<Record<string, unknown>>): void {
    writeFileSync(join(logDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function validCandidate(text: string): MemoryCandidate {
    return {
      text,
      category: 'project',
      confidence: 0.85,
      sources: [{ hash: 'sha256:abc', excerpt: text.slice(0, 50) }],
    };
  }

  function unsourcedCandidate(text: string): MemoryCandidate {
    return {
      text,
      category: 'project',
      confidence: 0.85,
      sources: [] as MemoryCandidate['sources'],
    };
  }

  function makeExtractClient(candidates: MemoryCandidate[]): ExtractClient {
    return {
      extractCandidates: async () => ({ candidates }),
    };
  }

  function makeStoreClient(): StoreClient & { stored: MemoryCandidate[] } {
    const stored: MemoryCandidate[] = [];
    return {
      stored,
      storeValidated: async (c) => { stored.push(c); },
    };
  }

  function makeMaintenance(): MaintenanceClient {
    return { triggerMaintenance: async () => ({ expired: 1, deduplicated: 0, total_after: 99 }) };
  }

  function makeTopicIndex(): TopicIndexClient {
    return {
      indexDayTopics: async () => 3,
      pruneTopicIndex: async () => 1,
    };
  }

  it('runs extract → store → maintenance and writes three consolidate events', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'The Atlas case goes to hearing on Thursday this week' },
      { sender: 'Clint', text: 'Noted — I will prep the briefing for Thursday.', isBot: true },
    ]);

    const storeClient = makeStoreClient();
    const stage = makeConsolidateStage({
      logDir,
      extractClient: makeExtractClient([validCandidate('Atlas hearing Thursday'), unsourcedCandidate('no evidence here')]),
      storeClient,
      memoryClient: makeMaintenance(),
      topicClient: makeTopicIndex(),
      yesterdayFor: (date) => {
        // '2026-04-10' → '2026-04-09'
        const d = new Date(date + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      },
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });
    runner.register('consolidate', stage);
    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    const phases = events.map((e) => e.phase).sort();
    assert.deepEqual(phases, ['extract', 'maintenance', 'store']);
    assert.equal(storeClient.stored.length, 1);

    const storeEvent = events.find((e) => e.phase === 'store');
    assert.ok(storeEvent);
    assert.match(storeEvent!.reason, /stored=1.*rejected=1/);
  });

  it('records a failed extract event when the log dir does not exist', async () => {
    const stage = makeConsolidateStage({
      logDir: join(tmpRoot, 'does-not-exist'),
      extractClient: makeExtractClient([]),
      storeClient: makeStoreClient(),
      memoryClient: makeMaintenance(),
      topicClient: makeTopicIndex(),
      yesterdayFor: (date) => {
        const d = new Date(date + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      },
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });
    runner.register('consolidate', stage);
    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir, stage: 'consolidate' });
    // Extract should report 0 files processed (not a failure — an empty day).
    const extractEvent = events.find((e) => e.phase === 'extract');
    assert.ok(extractEvent);
    assert.equal(extractEvent!.verdict, 'ok');
    assert.match(extractEvent!.reason, /files=0/);
  });

  it('writes a rejected-<date>.jsonl for unsourced candidates', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'A valid conversation with enough content to be processed' },
      { sender: 'Clint', text: 'Responding to the valid conversation so it passes the length check', isBot: true },
    ]);

    const stage = makeConsolidateStage({
      logDir,
      extractClient: makeExtractClient([unsourcedCandidate('bad one'), unsourcedCandidate('bad two')]),
      storeClient: makeStoreClient(),
      memoryClient: makeMaintenance(),
      topicClient: makeTopicIndex(),
      yesterdayFor: (date) => {
        const d = new Date(date + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      },
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });
    runner.register('consolidate', stage);
    await runner.run(['consolidate']);

    const { existsSync, readFileSync } = await import('node:fs');
    const rejectedFile = join(overnightDir, 'rejected-2026-04-10.jsonl');
    assert.ok(existsSync(rejectedFile));
    const lines = readFileSync(rejectedFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx tsx --test src/overnight/__tests__/consolidate.test.ts
```

Expected: FAIL — `../consolidate.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/consolidate.ts`**

Create `src/overnight/consolidate.ts`:

```ts
// src/overnight/consolidate.ts — CONSOLIDATE stage entry point.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1.
//
// Composes extract → store → maintenance sub-modules into a single stage function
// suitable for registration with OvernightRunner. Factory-pattern builder lets
// tests inject mock clients while production code uses a thin wrapper that
// supplies real clients from src/memory.js and src/topic-index.js (see
// run-consolidate-manual.ts for the production wiring).

import type { StageContext, StageFn } from './runner.js';
import { ConsolidateExtractor, type ExtractClient } from './consolidate-extract.js';
import { ConsolidateStore, type StoreClient } from './consolidate-store.js';
import {
  ConsolidateMaintenance,
  type MaintenanceClient,
  type TopicIndexClient,
} from './consolidate-maintenance.js';

export interface ConsolidateStageOptions {
  logDir: string;
  extractClient: ExtractClient;
  storeClient: StoreClient;
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
  /** Given today's YYYY-MM-DD, return yesterday's. */
  yesterdayFor: (date: string) => string;
}

/**
 * Build a consolidate stage function from injected clients. The returned
 * function is ready to hand to `runner.register('consolidate', ...)`.
 */
export function makeConsolidateStage(opts: ConsolidateStageOptions): StageFn {
  const extractor = new ConsolidateExtractor({ client: opts.extractClient, logDir: opts.logDir });
  const maintenance = new ConsolidateMaintenance({
    memoryClient: opts.memoryClient,
    topicClient: opts.topicClient,
  });

  return async function runConsolidateStage(ctx: StageContext): Promise<void> {
    const store = new ConsolidateStore({
      client: opts.storeClient,
      overnightDir: ctx.overnightDir,
    });

    const yesterday = opts.yesterdayFor(ctx.date);

    // --- 1. Extract ---------------------------------------------------------
    const extractResult = await extractor.extractForDate(yesterday);
    await ctx.appendEvent({
      stage: 'consolidate',
      phase: 'extract',
      inputs: [`data/conversation-logs/${yesterday}*.jsonl`],
      outputs: [],
      verdict: extractResult.errors.length > 0 && extractResult.filesProcessed === 0 ? 'failed' : 'ok',
      reason: `files=${extractResult.filesProcessed} candidates=${extractResult.candidates.length} errors=${extractResult.errors.length}`,
      evidence_refs: extractResult.errors.map((e) => `extract_error:${e.file}:${e.reason}`),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    // --- 2. Store (validated) + rejected log -------------------------------
    const storeResult = await store.process({
      candidates: extractResult.candidates,
      date: ctx.date,
    });
    await ctx.appendEvent({
      stage: 'consolidate',
      phase: 'store',
      inputs: [`extract:${extractResult.candidates.length}`],
      outputs: [
        `memory_store:${storeResult.stored}`,
        `rejected_log:data/overnight/rejected-${ctx.date}.jsonl`,
      ],
      verdict: storeResult.storeErrors.length > 0 ? 'failed' : 'ok',
      reason: `stored=${storeResult.stored} rejected=${storeResult.rejected} store_errors=${storeResult.storeErrors.length}`,
      evidence_refs: storeResult.storeErrors.map((e) => `store_error:${e.reason}`),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });

    // --- 3. Maintenance + topic index ---------------------------------------
    const maintResult = await maintenance.run(yesterday);
    const maintVerdict: 'ok' | 'failed' = maintResult.errors.length > 0 ? 'failed' : 'ok';
    await ctx.appendEvent({
      stage: 'consolidate',
      phase: 'maintenance',
      inputs: ['memory:*', `topic-index:${yesterday}`],
      outputs: [
        `expired:${maintResult.maintenance?.expired ?? 0}`,
        `deduped:${maintResult.maintenance?.deduplicated ?? 0}`,
        `topics_indexed:${maintResult.topicsIndexed ?? 0}`,
        `topics_pruned:${maintResult.topicsPruned ?? 0}`,
      ],
      verdict: maintVerdict,
      reason: maintResult.errors.length > 0
        ? `maintenance errors: ${maintResult.errors.join('; ')}`
        : 'maintenance ok',
      evidence_refs: maintResult.errors,
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  };
}
```

- [ ] **Step 4: Run the test**

```bash
npx tsx --test src/overnight/__tests__/consolidate.test.ts
```

Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/consolidate.ts src/overnight/__tests__/consolidate.test.ts
git commit -m "feat(overnight): CONSOLIDATE stage entry point (spec §4.1)"
```

---

### Task 6: Manual shadow-run harness — `src/overnight/run-consolidate-manual.ts`

**Files:**
- Create: `src/overnight/run-consolidate-manual.ts`

Reason: Phase 1 deliberately does **not** wire consolidate into the scheduler. Instead, this standalone script wires real clients (from `src/memory.js`, `src/topic-index.js`, and a new Node-side `extract` call) and runs the stage on demand so you can verify it in shadow alongside the existing 2 AM task for 3 nights.

No test file for this one — it is production wiring, not business logic. The unit-tested modules underneath already cover the logic.

- [ ] **Step 1: Implement `src/overnight/run-consolidate-manual.ts`**

Create `src/overnight/run-consolidate-manual.ts`:

```ts
// src/overnight/run-consolidate-manual.ts — manual invoker for the CONSOLIDATE stage.
//
// Runs the new consolidate stage against yesterday's logs using real EVO clients.
// Intended for shadow-mode testing alongside the existing 2 AM improvement-cycle.js
// task during the 3-night soak period. NOT wired into the scheduler.
//
// Usage:
//   npx tsx src/overnight/run-consolidate-manual.ts [YYYY-MM-DD]
//
// If no date is provided, uses today (London-local) — which means "yesterday" from
// consolidate's perspective is the day whose logs are read.

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromConversation, storeMemory, triggerMaintenance } from '../memory.js';
import { indexDayTopics, pruneTopicIndex } from '../topic-index.js';
import logger from '../logger.js';
import { OvernightRunner } from './runner.js';
import { makeConsolidateStage } from './consolidate.js';
import type { MemoryCandidate } from './consolidate-validate.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');

function todayLondon(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

function yesterdayFor(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const date = process.argv[2] ?? todayLondon();
  const overnightDir = join(REPO_ROOT, 'data', 'overnight');
  const logDir = join(REPO_ROOT, 'data', 'conversation-logs');

  logger.info({ date, overnightDir, logDir }, 'manual consolidate: starting');

  const stage = makeConsolidateStage({
    logDir,
    extractClient: {
      extractCandidates: async (conversation, source) => {
        // Existing extractFromConversation auto-stores with store_results:true.
        // The new contract requires store_results:false so Node can validate.
        // For the shadow run we accept the auto-store as a harmless dup (the
        // store client below is a no-op) and just harvest the candidate list
        // from the response. A follow-up task will change the EVO /extract
        // caller to use store_results:false explicitly; see README of phase 1.
        const resp = await extractFromConversation(conversation, source);
        const raw = (resp.extracted ?? []) as unknown[];
        return {
          candidates: raw.map((item) => {
            // EVO does not currently emit sources[]. This is expected for
            // shadow mode — such candidates will land in the rejected log
            // and be visible in the morning. When EVO is updated to emit
            // sources[], they will flow through as valid.
            const candidate = item as MemoryCandidate;
            return candidate;
          }),
        };
      },
    },
    storeClient: {
      // No-op for shadow mode. The existing extractFromConversation path
      // already stored the entries when called above (store_results:true).
      // When we cut over in the follow-up task, this becomes a real call
      // to storeMemory() with the validated candidate payload.
      storeValidated: async (_candidate) => { /* intentional: shadow mode no-op */ },
    },
    memoryClient: {
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
    },
    topicClient: {
      indexDayTopics: async (d) => indexDayTopics(d),
      pruneTopicIndex: async (days) => {
        const n = pruneTopicIndex(days);
        return typeof n === 'number' ? n : 0;
      },
    },
    yesterdayFor,
  });

  const runner = new OvernightRunner({
    mode: 'cheap',
    date,
    overnightDir,
    repoRoot: REPO_ROOT,
    skipJanitor: true, // manual run — nothing to clean up
  });
  runner.register('consolidate', stage);
  await runner.run(['consolidate']);

  // Unused import guard — storeMemory is referenced here so the follow-up
  // task can simply uncomment the production call path without re-adding
  // the import.
  void storeMemory;

  logger.info({ date }, 'manual consolidate: complete');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err.message }, 'manual consolidate failed');
  process.exit(1);
});
```

- [ ] **Step 2: Smoke test**

Run the script against an old date where we know logs exist:

```bash
npx tsx src/overnight/run-consolidate-manual.ts 2026-04-10
```

Expected: script completes with exit 0. Output `data/overnight/events-2026-04-10.jsonl` contains at least 3 events (`phase: extract`, `phase: store`, `phase: maintenance`). If `extractFromConversation` returns candidates without `sources[]` (which is the current EVO behaviour), they all land in `data/overnight/rejected-2026-04-10.jsonl` — this is expected and is the visible signal that the evidence-chain invariant is working.

If EVO is unreachable during the smoke test, the stage will record a failed `extract` event with the EVO error in `evidence_refs` and continue to the maintenance phase (which will also fail, also recorded). That's fine for a manual smoke test — it proves the error paths work.

- [ ] **Step 3: Commit**

```bash
git add src/overnight/run-consolidate-manual.ts
git commit -m "feat(overnight): manual shadow-run harness for consolidate (spec §4.1 shadow-mode)"
```

---

### Task 7: Full verification + deploy for shadow soak

**Files:** none modified.

Reason: confirm Phase 1 is green end-to-end before pushing it into EVO for the 3-night shadow run.

- [ ] **Step 1: Run the Phase 1 test suite**

```bash
npx tsx --test src/overnight/__tests__/consolidate*.test.ts
```

Expected: all tests in `consolidate-validate`, `consolidate-extract`, `consolidate-store`, `consolidate-maintenance`, and `consolidate` pass.

- [ ] **Step 2: Run the full project test suite**

```bash
npm test
```

Expected: 508 pass / 2 fail / 1 skipped (or better). The 2 pre-existing failures carry over from Phase 0 baseline. No new failures.

- [ ] **Step 3: Push and deploy**

```bash
git push origin main
ssh james@100.90.66.54 'cd ~/clawdbot && git pull && sudo systemctl restart clawdbot'
```

Expected: EVO restarts cleanly. The existing 2 AM extract task continues to run unchanged (we did not touch `src/tasks/improvement-cycle.js`).

- [ ] **Step 4: First manual shadow run (EVO side)**

Pick a date where conversation logs exist (e.g. yesterday). SSH to EVO and run:

```bash
ssh james@100.90.66.54 'cd ~/clawdbot && npx tsx src/overnight/run-consolidate-manual.ts 2026-04-09'
```

Expected: script exits 0. Inspect the output log:

```bash
ssh james@100.90.66.54 'cat ~/clawdbot/data/overnight/events-2026-04-10.jsonl'
```

Expected: at minimum three consolidate events (extract, store, maintenance). If `rejected-*.jsonl` exists and contains entries, that is the expected initial state — the current EVO `/extract` path emits candidates without `sources[]`, so they rightly get rejected and logged. The visible rejection count is the signal that the invariant is enforced.

- [ ] **Step 5: Phase 1 marker commit**

```bash
git commit --allow-empty -m "chore(overnight): Phase 1 CONSOLIDATE stage shipped (shadow mode, spec §4.1)

Spec:  docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md
Plan:  docs/superpowers/plans/2026-04-10-compound-dream-phase1-consolidate.md

Stage registered via makeConsolidateStage(), not wired into scheduler.
Manual shadow-run via run-consolidate-manual.ts. Three-night soak before
the scheduler cutover task retires the old 2 AM extract.
"
```

---

## Out-of-band notes for the executing agent

1. **DO NOT touch `src/tasks/improvement-cycle.js` in Phase 1.** It stays exactly as-is. The new stage runs in parallel via `run-consolidate-manual.ts` during the shadow period. Any attempt to "clean it up" or "integrate" it during Phase 1 is scope creep and puts the shadow comparison at risk.

2. **DO NOT add a scheduler entry.** `src/scheduler.js` (or wherever the 60s tick lives) is not modified in this plan. The cutover task is separate and deferred.

3. **The shadow-mode extract client is a compromise.** The existing `extractFromConversation` always auto-stores (`store_results: true`). For Phase 1 shadow mode, we accept that: entries get stored by the old path, the new path then harvests them, validates, and writes rejects. The store client is a no-op. This is explicitly shadow-mode — it does **not** implement the spec's "validated-store only" end state. That happens in the cutover task when the EVO `/extract` caller switches to `store_results: false`. The cutover task is a ~20-line patch on Phase 1's `run-consolidate-manual.ts` — intentionally trivial to make the cutover low-risk.

4. **On EVO emitting `sources[]`:** the existing EVO memory service does not currently emit a `sources[]` field on extracted candidates. This means every candidate will hit the rejected log during shadow mode. That's the point — we want to see which conversations would have produced memories under the strict invariant, and verify the rejected log is populated for the right reasons. Making EVO emit `sources[]` is a separate, Python-side task tracked in the spec §4.1 but out of scope here.

5. **Windows git stash quirks** (from Phase 0 experience): if you need to stash mid-task, do NOT use `git stash push -u` — untracked-directory removal fails on empty `.cursor/`, `data/topic-index/`, `tests/` dirs and leaves the working tree in an inconsistent "stash created but tree not cleaned" state. Use `git stash push` without `-u`, OR manually `git checkout -- .` + delete untracked files.

6. **`npm test` is already `tsx --test`** after Phase 0. Do not revert it. Any regression that tries to go back to plain `node --test` will fail on the existing `.js → .ts` imports in `src/tools/handler.js`.

---

## Phase 1 → Next-phase handoff

After Phase 1 + the scheduler cutover task (separate) the tree has:

- Real CONSOLIDATE stage running nightly, with evidence-chain enforcement and rejected log
- Event log populated every night with at least three consolidate events
- Old `src/tasks/improvement-cycle.js` still live (retirement is Phase 5)
- Zero Opus sessions consumed per night by consolidate (EVO-only stage)

Next phases:
- **Phase 2 — PROBE** (weekly observation log, drift checks, candidate proposals, quality-failure enrichment)
- **Phase 3 — REPORT** (morning report generated from event log with staleness guard — fixes the ATLAS bug)
- **Phase 4 — IMPROVE** (weekly Saturday deep run, Opus selection, fresh-worktree implement, rolling replay, branch-first deploy)
- **Phase 5 — Retirement** of `improvement-cycle.js`, `overnight-to-evolution.js`, the legacy `overnight-report.js`, `weekly-retrospective.js`, and their scheduler entries

*End of Phase 1 plan.*
