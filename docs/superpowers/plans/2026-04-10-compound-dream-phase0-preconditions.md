# Compound Dream — Phase 0: Preconditions & Shared Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md` §5.4, §5.5, §6.1, §6.2

**Goal:** Lay the foundation for the compound-dream overnight refactor — git hygiene (`.gitattributes`, runtime-state file relocation), the shared `data/overnight/` event log directory, and the `src/overnight/` helper library (events, budget, tiering, worktree, runner skeleton) that every subsequent phase depends on.

**Architecture:** A single new directory `src/overnight/` holds pure TypeScript helpers with narrow responsibilities: `events.ts` (append-only JSONL event log with schema validation), `budget.ts` (Opus session tracker with London-time reset), `tiering.ts` (deterministic tier classifier + banned file list), `worktree.ts` (`withWorktree` helper that isolates code-modifying work from the main checkout), `runner.ts` (orchestrator skeleton that declares stage entry points, enforces budget, and writes synthetic failure events). All new code is TypeScript executed via `tsx`. No business logic yet — the stages themselves (CONSOLIDATE / PROBE / REPORT / IMPROVE) arrive in Phases 1-4. Runtime-state files that the live bot writes (`group-registry.json`, `learned-rules.json`, `projects.json`, `system-knowledge/meta.json`) move to `data/runtime/` and out of git.

**Tech Stack:** Node.js 20+ ESM, TypeScript (strict, `noUncheckedIndexedAccess`), `tsx` runner, `node:test` + `mock.fn()` for tests, `esmock` if module-level mocking becomes necessary (not expected in Phase 0), `node:fs/promises` for file I/O, `node:child_process` for git worktree commands.

**Out of scope for Phase 0:** Any stage logic. Dream extraction. Quality gates. Opus selection. Rolling replay. Staleness cleanup of `data/overnight-results/` (directory does not currently exist — confirmed, nothing to clean). Changes to `forge-orchestrator.js` (still running; retired in Phase 5). Scheduler wiring (Phase 1+).

**Non-goal guardrail:** Phase 0 is allowed to add files and move runtime state. It is **not** allowed to delete or modify existing overnight code (`forge-orchestrator.js`, `overnight-report.js`, `improvement-cycle.js`, `weekly-retrospective.js`, `overnight-to-evolution.js`, `evolution*.js`, `manual-improvement-run.js`). Those still run on EVO every night until later phases retire them.

---

## File Structure

**Created by this phase:**

```
.gitattributes                              New — forces LF on tracked text files (P2)
data/runtime/                               New dir — runtime-written state, gitignored
data/runtime/.gitkeep                       Placeholder so empty dir survives git
data/runtime-defaults/                      New dir — committed defaults for fresh clones
data/runtime-defaults/group-registry.json   Seed copy
data/runtime-defaults/learned-rules.json    Seed copy
data/runtime-defaults/projects.json         Seed copy
data/runtime-defaults/system-knowledge-meta.json  Seed copy
data/overnight/                             New dir — event logs + observation logs
data/overnight/.gitkeep                     Placeholder
data/overnight/archive/                     New dir — weekly observation archives
data/overnight/archive/.gitkeep             Placeholder
src/overnight/                              New dir — shared helper library
src/overnight/paths.ts                      Resolves data paths from config + seed fallback
src/overnight/events.ts                     Event log schema + appendEvent + queryEvents
src/overnight/budget.ts                     Opus session tracker with London-time reset
src/overnight/tiering.ts                    Tier classifier + banned files list
src/overnight/worktree.ts                   withWorktree(fn) helper + janitor
src/overnight/runner.ts                     Stage orchestrator skeleton
src/overnight/__tests__/paths.test.ts       Unit tests
src/overnight/__tests__/events.test.ts      Unit tests
src/overnight/__tests__/budget.test.ts      Unit tests
src/overnight/__tests__/tiering.test.ts     Unit tests
src/overnight/__tests__/worktree.test.ts    Unit tests (uses tmp dir, real git)
src/overnight/__tests__/runner.test.ts      Unit tests (skeleton behaviour only)
```

**Modified by this phase:**

```
.gitignore                                  Add data/runtime/ (and keep runtime-defaults/ tracked)
src/group-registry.js                       Read from data/runtime/group-registry.json
src/self-improve/cycle.js                   Read from data/runtime/learned-rules.json (if present)
src/tools/projects.js                       Read from data/runtime/projects.json
src/system-knowledge.js                     Read from data/runtime/system-knowledge/meta.json
src/config.js                               Export runtime-state paths from a single place
```

**Deliberately NOT modified in Phase 0** (touched in later phases, listed so the executing agent does not edit them now):

```
src/tasks/forge-orchestrator.js             Retired in Phase 5
src/overnight-report.js                     Replaced in Phase 3
src/tasks/improvement-cycle.js              Retired in Phase 5
src/tasks/weekly-retrospective.js           Retired in Phase 5
src/prompt.js                               Contains references to runtime state via helpers
src/router.js                               Contains references to runtime state via helpers
src/tools/handler.js                        References runtime state via helpers
src/project-thinker.js                      References runtime state via helpers
src/output-filter.js                        References runtime state via helpers
```

These files all access runtime state through the helpers listed in "Modified by this phase" (`group-registry.js`, `self-improve/cycle.js`, `tools/projects.js`, `system-knowledge.js`). Updating the helpers is sufficient — the callers do not need to change.

---

### Task 1: Add `.gitattributes` for LF line endings

**Files:**
- Create: `.gitattributes`

Reason: fixes the CRLF warning storm on James's Windows clone and stops future forge diffs being polluted with line-ending noise. Mandated by spec §6.1 P2.

- [ ] **Step 1: Create `.gitattributes`**

Create `.gitattributes`:

```
# Force LF line endings on all tracked text files.
# Mandated by docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §6.1 P2.
* text=auto eol=lf

*.js text eol=lf
*.ts text eol=lf
*.mjs text eol=lf
*.cjs text eol=lf
*.json text eol=lf
*.md text eol=lf
*.sh text eol=lf
*.yml text eol=lf
*.yaml text eol=lf
*.toml text eol=lf

# Binary files — never touch.
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.ico binary
*.pdf binary
*.wav binary
*.mp3 binary
*.mp4 binary
*.ogg binary
*.webm binary
```

- [ ] **Step 2: Renormalise the index**

This is the one-time housekeeping step the `.gitattributes` docs recommend after adding the file, so existing tracked content is rewritten with LF endings according to the new rules.

Run:
```bash
git add --renormalize .
git status --short
```

Expected: modified files listed (if any). On James's Windows clone you may see many files flagged; on EVO (which has LF already) you may see none. Do not be alarmed either way.

- [ ] **Step 3: Stage `.gitattributes` and commit the renormalisation**

Run:
```bash
git add .gitattributes
git commit -m "chore(repo): add .gitattributes, force LF line endings (spec §6.1 P2)"
```

Expected: single commit created. If Step 2 produced additional renormalised files, they are included in this commit.

---

### Task 2: Create the `data/overnight/` and `data/runtime/` directory layout

**Files:**
- Create: `data/overnight/.gitkeep`
- Create: `data/overnight/archive/.gitkeep`
- Create: `data/runtime/.gitkeep`
- Create: `data/runtime-defaults/.gitkeep`

- [ ] **Step 1: Create the directories and placeholders**

Run:
```bash
mkdir -p data/overnight/archive data/runtime data/runtime-defaults
touch data/overnight/.gitkeep data/overnight/archive/.gitkeep data/runtime/.gitkeep data/runtime-defaults/.gitkeep
```

- [ ] **Step 2: Verify**

Run:
```bash
ls -la data/overnight data/overnight/archive data/runtime data/runtime-defaults
```

Expected: each directory exists and contains a `.gitkeep` file.

- [ ] **Step 3: Commit the empty directories**

Run:
```bash
git add data/overnight/.gitkeep data/overnight/archive/.gitkeep data/runtime/.gitkeep data/runtime-defaults/.gitkeep
git commit -m "chore(data): add data/overnight/ and data/runtime/ directory structure"
```

Expected: single commit created.

---

### Task 3: Relocate runtime-state files to `data/runtime/` with seed defaults (§6.1 P1)

**Files:**
- Copy: `data/group-registry.json` → `data/runtime-defaults/group-registry.json`
- Copy: `data/learned-rules.json` → `data/runtime-defaults/learned-rules.json`
- Copy: `data/projects.json` → `data/runtime-defaults/projects.json`
- Copy: `data/system-knowledge/meta.json` → `data/runtime-defaults/system-knowledge-meta.json`
- Delete (git rm): `data/group-registry.json`, `data/learned-rules.json`, `data/projects.json`, `data/system-knowledge/meta.json`
- Modify: `.gitignore`

Reason: spec §6.1 P1 — these four files are written by the live bot at runtime and should not be tracked. Defaults are committed to `data/runtime-defaults/` so a fresh clone still has something sensible, and the bot seeds `data/runtime/` from defaults on first boot in Task 4.

**⚠ PRE-TASK CONFIRMATION REQUIRED:** `data/group-registry.json` currently exists on EVO in a "Restored by tests" state with the `LQCore` group removed. James has been asked to decide whether to restore the `LQCore` entry before this task runs. Do **not** execute this task until James has confirmed the intended content of `data/group-registry.json` (and either updated the live file on EVO or confirmed the current EVO content is correct). The copy to `data/runtime-defaults/` will freeze whatever's there as the committed default.

- [ ] **Step 1: Verify pre-task confirmation**

Ask James: "has the `data/group-registry.json` LQCore decision been made and is the current content correct?" Do not proceed until explicit yes.

- [ ] **Step 2: Copy current files to `data/runtime-defaults/`**

Run:
```bash
cp data/group-registry.json data/runtime-defaults/group-registry.json
cp data/learned-rules.json data/runtime-defaults/learned-rules.json
cp data/projects.json data/runtime-defaults/projects.json
cp data/system-knowledge/meta.json data/runtime-defaults/system-knowledge-meta.json
```

Expected: four files now present under `data/runtime-defaults/`.

- [ ] **Step 3: Also copy them to `data/runtime/` so a running bot does not lose state**

Run:
```bash
cp data/group-registry.json data/runtime/group-registry.json
cp data/learned-rules.json data/runtime/learned-rules.json
cp data/projects.json data/runtime/projects.json
mkdir -p data/runtime/system-knowledge
cp data/system-knowledge/meta.json data/runtime/system-knowledge/meta.json
```

Expected: four files now present under `data/runtime/` (mirroring defaults).

- [ ] **Step 4: Remove the old tracked copies**

Run:
```bash
git rm data/group-registry.json data/learned-rules.json data/projects.json data/system-knowledge/meta.json
```

Expected: four files removed from the index. The working-tree versions inside `data/runtime/` and `data/runtime-defaults/` are untouched.

- [ ] **Step 5: Update `.gitignore`**

Edit `.gitignore`. Find this section:

```
# Runtime data (user-specific, regenerated)
data/soul*.json
data/audit.json
```

Add these lines immediately after `data/audit.json`, before the next block:

```
# Runtime state — written by the live bot, seeded from data/runtime-defaults/
data/runtime/
!data/runtime/.gitkeep
```

Do **not** add `data/runtime-defaults/` — defaults must stay tracked.

- [ ] **Step 6: Verify `.gitignore` is effective**

Run:
```bash
git check-ignore -v data/runtime/group-registry.json
git check-ignore -v data/runtime/system-knowledge/meta.json
git check-ignore -v data/runtime-defaults/group-registry.json 2>&1 || echo "(defaults NOT ignored — correct)"
```

Expected:
- `data/runtime/group-registry.json` → reported as ignored by the new rule
- `data/runtime/system-knowledge/meta.json` → reported as ignored
- `data/runtime-defaults/group-registry.json` → `(defaults NOT ignored — correct)` printed

- [ ] **Step 7: Stage defaults and the gitignore change**

Run:
```bash
git add .gitignore data/runtime-defaults/
git status --short
```

Expected output should show:
```
M  .gitignore
A  data/runtime-defaults/.gitkeep
A  data/runtime-defaults/group-registry.json
A  data/runtime-defaults/learned-rules.json
A  data/runtime-defaults/projects.json
A  data/runtime-defaults/system-knowledge-meta.json
D  data/group-registry.json
D  data/learned-rules.json
D  data/projects.json
D  data/system-knowledge/meta.json
```

- [ ] **Step 8: Commit**

Run:
```bash
git commit -m "refactor(runtime): move runtime-state files to data/runtime/ (spec §6.1 P1)

- Move group-registry, learned-rules, projects, system-knowledge/meta to data/runtime/
- Add data/runtime/ to .gitignore so live-bot writes don't show as diff noise
- Commit frozen defaults to data/runtime-defaults/ for fresh-clone seeding
- Helper modules that read these files are updated in Task 4"
```

Expected: single commit containing the 4 deletions, 5 adds (4 defaults + .gitkeep already committed in Task 2), and the .gitignore update.

---

### Task 4: Teach the existing helpers to read from `data/runtime/` with seed fallback

**Files:**
- Modify: `src/config.js` (add `runtimePath()` export)
- Modify: `src/group-registry.js` (use `runtimePath()`)
- Modify: `src/system-knowledge.js` (use `runtimePath()`)
- Modify: `src/tools/projects.js` (use `runtimePath()`)
- Modify: `src/self-improve/cycle.js` (use `runtimePath()`, only if it reads `learned-rules.json`)

Reason: spec §6.1 P1 — "Any code that reads them is updated to the new path". The helpers need to resolve paths from a single place and fall back to the committed default on first read if the runtime file doesn't exist yet (fresh clone or EVO boot after Phase 0).

**Approach:** add a single `runtimePath(name)` function in `src/config.js` that returns the runtime path and, if the file is missing, copies it from the default before returning. All helpers use it.

- [ ] **Step 1: Write a failing test for `runtimePath()` seed behaviour**

Create `src/overnight/__tests__/paths.test.ts`:

```ts
// Phase 0 tests for runtime-path seeding. Lives under src/overnight/__tests__/
// because the helper being tested will move to src/overnight/paths.ts in Step 3;
// the test file stays here afterwards.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimePath } from '../paths.js';

describe('overnight/paths.runtimePath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-paths-'));
    mkdirSync(join(tmpRoot, 'runtime'));
    mkdirSync(join(tmpRoot, 'runtime-defaults'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the runtime file path when it already exists', () => {
    const runtimeFile = join(tmpRoot, 'runtime', 'group-registry.json');
    writeFileSync(runtimeFile, '{"groups":{}}', 'utf8');

    const result = runtimePath('group-registry.json', {
      runtimeDir: join(tmpRoot, 'runtime'),
      defaultsDir: join(tmpRoot, 'runtime-defaults'),
    });

    assert.equal(result, runtimeFile);
    assert.equal(readFileSync(result, 'utf8'), '{"groups":{}}');
  });

  it('seeds the runtime file from defaults when missing', () => {
    const defaultFile = join(tmpRoot, 'runtime-defaults', 'group-registry.json');
    writeFileSync(defaultFile, '{"groups":{"seed":true}}', 'utf8');

    const result = runtimePath('group-registry.json', {
      runtimeDir: join(tmpRoot, 'runtime'),
      defaultsDir: join(tmpRoot, 'runtime-defaults'),
    });

    assert.equal(result, join(tmpRoot, 'runtime', 'group-registry.json'));
    assert.ok(existsSync(result), 'runtime file should now exist');
    assert.equal(readFileSync(result, 'utf8'), '{"groups":{"seed":true}}');
  });

  it('throws a clear error when neither runtime nor defaults exist', () => {
    assert.throws(
      () => runtimePath('nonexistent.json', {
        runtimeDir: join(tmpRoot, 'runtime'),
        defaultsDir: join(tmpRoot, 'runtime-defaults'),
      }),
      /no default at .*nonexistent\.json/,
    );
  });

  it('supports nested names like system-knowledge/meta.json', () => {
    const defaultFile = join(tmpRoot, 'runtime-defaults', 'system-knowledge-meta.json');
    writeFileSync(defaultFile, '{"version":1}', 'utf8');

    const result = runtimePath('system-knowledge/meta.json', {
      runtimeDir: join(tmpRoot, 'runtime'),
      defaultsDir: join(tmpRoot, 'runtime-defaults'),
    });

    assert.equal(result, join(tmpRoot, 'runtime', 'system-knowledge', 'meta.json'));
    assert.equal(readFileSync(result, 'utf8'), '{"version":1}');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/paths.test.ts
```

Expected: FAIL with a module-not-found error (`../paths.js` does not exist yet). If any other error appears, stop and diagnose before continuing.

- [ ] **Step 3: Implement `src/overnight/paths.ts`**

Create `src/overnight/paths.ts`:

```ts
// src/overnight/paths.ts — runtime-state path resolution with seed fallback.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §6.1 P1.
//
// Runtime state files live in data/runtime/ (gitignored, live-bot writes).
// On first read, if the runtime file is missing, it is seeded from
// data/runtime-defaults/<flattened-name>. This lets a fresh clone boot
// without needing an external seed script.

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// src/overnight/paths.ts → repo root is two dirs up.
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');

const DEFAULT_RUNTIME_DIR = join(REPO_ROOT, 'data', 'runtime');
const DEFAULT_DEFAULTS_DIR = join(REPO_ROOT, 'data', 'runtime-defaults');

export interface RuntimePathOptions {
  runtimeDir?: string;
  defaultsDir?: string;
}

/**
 * Resolve the on-disk path for a runtime-state file, seeding from defaults if missing.
 *
 * @param name Logical file name relative to data/runtime/, e.g. "group-registry.json"
 *             or "system-knowledge/meta.json". Nested names map to a flattened default
 *             filename (slashes replaced with "-") in data/runtime-defaults/.
 * @param opts Override directories (for tests). Defaults point at the repo.
 * @returns Absolute path to the runtime file. If it did not exist, it has now been seeded.
 * @throws  Error if neither the runtime file nor a matching default exists.
 */
export function runtimePath(name: string, opts: RuntimePathOptions = {}): string {
  const runtimeDir = opts.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const defaultsDir = opts.defaultsDir ?? DEFAULT_DEFAULTS_DIR;

  const runtimeFile = join(runtimeDir, name);
  if (existsSync(runtimeFile)) return runtimeFile;

  const flattenedName = name.replace(/\//g, '-');
  const defaultFile = join(defaultsDir, flattenedName);
  if (!existsSync(defaultFile)) {
    throw new Error(
      `runtimePath: no default at ${defaultFile} to seed ${runtimeFile} from`,
    );
  }

  mkdirSync(dirname(runtimeFile), { recursive: true });
  copyFileSync(defaultFile, runtimeFile);
  return runtimeFile;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
npx tsx --test src/overnight/__tests__/paths.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Read `src/group-registry.js` to find the existing path reference**

Run:
```bash
grep -n "group-registry.json" src/group-registry.js
```

Record the line number of the current hardcoded path reference. The replacement imports `runtimePath` from `./overnight/paths.js` and calls it instead of a hardcoded `./data/group-registry.json` or equivalent.

- [ ] **Step 6: Patch `src/group-registry.js` to use `runtimePath()`**

Edit `src/group-registry.js`:

Add near the top (after existing imports, before any constant definitions):

```js
import { runtimePath } from './overnight/paths.js';
```

Replace the existing path constant (whatever form it takes — `./data/group-registry.json`, `path.join('data', 'group-registry.json')`, etc.) with a lazy accessor:

```js
const REGISTRY_FILE = () => runtimePath('group-registry.json');
```

And update every call site that used the old constant to call `REGISTRY_FILE()` instead. If the original code used a constant (immediate resolve), the function form is required so the seed copy happens on first read, not at module load time.

- [ ] **Step 7: Manually verify `src/group-registry.js` still loads**

Run:
```bash
node --input-type=module -e "import('./src/group-registry.js').then(m => console.log('loaded', Object.keys(m)))"
```

Expected: prints `loaded` followed by the module's exported keys with no error. If an error occurs, the module's path handling needs adjusting before continuing.

- [ ] **Step 8: Repeat Steps 5-7 for `src/system-knowledge.js`**

Find the reference:
```bash
grep -n "system-knowledge/meta" src/system-knowledge.js
```

Apply the same `runtimePath('system-knowledge/meta.json')` pattern. Verify the module loads.

- [ ] **Step 9: Repeat Steps 5-7 for `src/tools/projects.js`**

Find the reference:
```bash
grep -n "projects.json" src/tools/projects.js
```

Import from `../overnight/paths.js` (one extra `..` because it's in `src/tools/`). Verify the module loads.

- [ ] **Step 10: Check whether `src/self-improve/cycle.js` reads `learned-rules.json`**

Run:
```bash
grep -n "learned-rules.json" src/self-improve/cycle.js
```

If a reference is found, apply the same pattern (import from `../overnight/paths.js`). If no reference is found, skip this step — `learned-rules.json` is written and/or read elsewhere and that caller will be updated when it is next touched. Record in the commit message which files were actually modified.

- [ ] **Step 11: Run the full test suite to confirm nothing broke**

Run:
```bash
npm test
```

Expected: all existing tests pass. The new `paths.test.ts` also passes. No new failures introduced.

- [ ] **Step 12: Commit**

Run:
```bash
git add src/overnight/paths.ts src/overnight/__tests__/paths.test.ts src/group-registry.js src/system-knowledge.js src/tools/projects.js
# Include src/self-improve/cycle.js only if it was actually modified in Step 10.
git commit -m "feat(overnight): runtimePath() helper + migrate live readers (spec §6.1 P1)

- New src/overnight/paths.ts with seed-on-first-read behaviour
- group-registry, system-knowledge, tools/projects now resolve via runtimePath()
- Unit tests cover existing file, seed fallback, missing default, nested names"
```

Expected: single commit. At this point the live bot (on EVO) can continue writing to `data/runtime/*.json` transparently, and a fresh clone will seed automatically.

---

### Task 5: Event log helpers — `src/overnight/events.ts`

**Files:**
- Create: `src/overnight/events.ts`
- Create: `src/overnight/__tests__/events.test.ts`

Reason: spec §5.4 — single source of truth for overnight work. Every stage appends structured events; the morning report queries them. "No event = did not happen."

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/events.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, queryEvents, eventLogPath, type OvernightEvent } from '../events.js';

describe('overnight/events', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-events-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('eventLogPath', () => {
    it('returns data/overnight/events-<date>.jsonl shaped path', () => {
      const p = eventLogPath('2026-04-10', { overnightDir: tmpRoot });
      assert.equal(p, join(tmpRoot, 'events-2026-04-10.jsonl'));
    });
  });

  describe('appendEvent', () => {
    const validEvent: Omit<OvernightEvent, 'id' | 'timestamp'> = {
      stage: 'consolidate',
      phase: 'extract',
      inputs: ['data/conversation-logs/2026-04-09.jsonl'],
      outputs: ['memory:abc123'],
      verdict: 'ok',
      reason: 'extracted 12 entries',
      evidence_refs: ['sha256:deadbeef'],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 4200 },
    };

    it('writes a valid event as one JSONL line with id and timestamp filled', async () => {
      const written = await appendEvent(validEvent, {
        date: '2026-04-10',
        overnightDir: tmpRoot,
      });

      assert.ok(written.id, 'id should be populated');
      assert.ok(written.timestamp, 'timestamp should be populated');
      assert.match(written.timestamp, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(written.stage, 'consolidate');

      const file = join(tmpRoot, 'events-2026-04-10.jsonl');
      assert.ok(existsSync(file));
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]!);
      assert.equal(parsed.id, written.id);
      assert.equal(parsed.stage, 'consolidate');
    });

    it('appends multiple events without overwriting', async () => {
      await appendEvent(validEvent, { date: '2026-04-10', overnightDir: tmpRoot });
      await appendEvent(
        { ...validEvent, phase: 'maintenance', reason: 'pruned 3 entries' },
        { date: '2026-04-10', overnightDir: tmpRoot },
      );

      const file = join(tmpRoot, 'events-2026-04-10.jsonl');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]!).phase, 'extract');
      assert.equal(JSON.parse(lines[1]!).phase, 'maintenance');
    });

    it('rejects events missing required fields', async () => {
      const bad = { stage: 'consolidate' } as unknown as Omit<OvernightEvent, 'id' | 'timestamp'>;
      await assert.rejects(
        () => appendEvent(bad, { date: '2026-04-10', overnightDir: tmpRoot }),
        /invalid event/i,
      );
    });

    it('rejects events with an unknown stage', async () => {
      const bad = { ...validEvent, stage: 'bogus' as unknown as OvernightEvent['stage'] };
      await assert.rejects(
        () => appendEvent(bad, { date: '2026-04-10', overnightDir: tmpRoot }),
        /stage/i,
      );
    });
  });

  describe('queryEvents', () => {
    it('returns all events for a single date', async () => {
      const base: Omit<OvernightEvent, 'id' | 'timestamp'> = {
        stage: 'probe',
        phase: 'drift-check',
        inputs: [],
        outputs: [],
        verdict: 'ok',
        reason: 'ok',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      };

      await appendEvent(base, { date: '2026-04-10', overnightDir: tmpRoot });
      await appendEvent({ ...base, phase: 'pattern-scan' }, { date: '2026-04-10', overnightDir: tmpRoot });

      const found = await queryEvents({ date: '2026-04-10', overnightDir: tmpRoot });
      assert.equal(found.length, 2);
      assert.deepEqual(
        found.map((e) => e.phase),
        ['drift-check', 'pattern-scan'],
      );
    });

    it('filters by stage when stage option is provided', async () => {
      const consolidateEvent: Omit<OvernightEvent, 'id' | 'timestamp'> = {
        stage: 'consolidate',
        phase: 'extract',
        inputs: [],
        outputs: [],
        verdict: 'ok',
        reason: '',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      };
      const probeEvent = { ...consolidateEvent, stage: 'probe' as const, phase: 'drift-check' };

      await appendEvent(consolidateEvent, { date: '2026-04-10', overnightDir: tmpRoot });
      await appendEvent(probeEvent, { date: '2026-04-10', overnightDir: tmpRoot });

      const probes = await queryEvents({ date: '2026-04-10', stage: 'probe', overnightDir: tmpRoot });
      assert.equal(probes.length, 1);
      assert.equal(probes[0]!.stage, 'probe');
    });

    it('returns empty array when no file exists for the date', async () => {
      const found = await queryEvents({ date: '2099-01-01', overnightDir: tmpRoot });
      assert.deepEqual(found, []);
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/events.test.ts
```

Expected: FAIL — `../events.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/events.ts`**

Create `src/overnight/events.ts`:

```ts
// src/overnight/events.ts — append-only event log for overnight stages.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §5.4.
//
// One file per night at data/overnight/events-<YYYY-MM-DD>.jsonl.
// Every stage writes events here; queryEvents() is the single read path.
// "No event = did not happen" — silent success is impossible by construction.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(REPO_ROOT, 'data', 'overnight');

export const OVERNIGHT_STAGES = ['consolidate', 'probe', 'report', 'improve'] as const;
export type OvernightStage = (typeof OVERNIGHT_STAGES)[number];

export const OVERNIGHT_VERDICTS = ['ok', 'rejected', 'failed', 'skipped', 'null'] as const;
export type OvernightVerdict = (typeof OVERNIGHT_VERDICTS)[number];

export interface OvernightEvent {
  id: string;
  timestamp: string; // ISO 8601
  stage: OvernightStage;
  phase: string;
  inputs: string[];
  outputs: string[];
  verdict: OvernightVerdict;
  reason: string;
  evidence_refs: string[];
  rollback_ref: string | null; // git sha if applicable
  budget: {
    opus_sessions: number;
    tokens: number;
  };
}

export interface AppendEventOptions {
  date?: string; // YYYY-MM-DD, defaults to today (UTC)
  overnightDir?: string;
}

export interface QueryEventsOptions {
  date: string; // YYYY-MM-DD
  stage?: OvernightStage;
  overnightDir?: string;
}

/** Resolve the log file path for a given date. */
export function eventLogPath(date: string, opts: { overnightDir?: string } = {}): string {
  const dir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  return join(dir, `events-${date}.jsonl`);
}

/** Append a new event. Fills in id and timestamp. Validates shape. */
export async function appendEvent(
  event: Omit<OvernightEvent, 'id' | 'timestamp'>,
  opts: AppendEventOptions = {},
): Promise<OvernightEvent> {
  validateEvent(event);

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;

  const written: OvernightEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };

  const file = eventLogPath(date, { overnightDir });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(written) + '\n', 'utf8');
  return written;
}

/** Query events for a specific date, optionally filtered by stage. */
export async function queryEvents(opts: QueryEventsOptions): Promise<OvernightEvent[]> {
  const file = eventLogPath(opts.date, { overnightDir: opts.overnightDir });
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const events = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OvernightEvent);

  return opts.stage ? events.filter((e) => e.stage === opts.stage) : events;
}

function validateEvent(event: Omit<OvernightEvent, 'id' | 'timestamp'>): void {
  const required: (keyof Omit<OvernightEvent, 'id' | 'timestamp'>)[] = [
    'stage', 'phase', 'inputs', 'outputs', 'verdict', 'reason', 'evidence_refs', 'rollback_ref', 'budget',
  ];
  for (const key of required) {
    if (!(key in event)) {
      throw new Error(`invalid event: missing required field "${key}"`);
    }
  }
  if (!OVERNIGHT_STAGES.includes(event.stage)) {
    throw new Error(`invalid event: stage "${event.stage}" not in ${OVERNIGHT_STAGES.join('|')}`);
  }
  if (!OVERNIGHT_VERDICTS.includes(event.verdict)) {
    throw new Error(`invalid event: verdict "${event.verdict}" not in ${OVERNIGHT_VERDICTS.join('|')}`);
  }
  if (!Array.isArray(event.inputs) || !Array.isArray(event.outputs) || !Array.isArray(event.evidence_refs)) {
    throw new Error('invalid event: inputs, outputs, and evidence_refs must be arrays');
  }
  if (typeof event.budget?.opus_sessions !== 'number' || typeof event.budget?.tokens !== 'number') {
    throw new Error('invalid event: budget.opus_sessions and budget.tokens must be numbers');
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
npx tsx --test src/overnight/__tests__/events.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/overnight/events.ts src/overnight/__tests__/events.test.ts
git commit -m "feat(overnight): event log schema + appendEvent/queryEvents (spec §5.4)"
```

Expected: single commit.

---

### Task 6: Budget tracker — `src/overnight/budget.ts`

**Files:**
- Create: `src/overnight/budget.ts`
- Create: `src/overnight/__tests__/budget.test.ts`

Reason: spec §5.5 — cap Opus sessions per night, refuse calls over budget, reset at 22:00 London. This is the single enforcement point for "the runner tracks sessions and refuses over-budget calls".

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/budget.test.ts`:

```ts
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetTracker, type BudgetNightMode } from '../budget.js';

describe('overnight/budget.BudgetTracker', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker({
      mode: 'cheap',
      now: () => new Date('2026-04-10T23:00:00Z'),
    });
  });

  describe('cheap night (1 session limit)', () => {
    it('allows the first session', () => {
      const result = tracker.requestSession({ stage: 'improve', purpose: 'selection' });
      assert.equal(result.allowed, true);
      assert.equal(tracker.sessionsUsed, 1);
    });

    it('refuses the second session', () => {
      tracker.requestSession({ stage: 'improve', purpose: 'selection' });
      const result = tracker.requestSession({ stage: 'improve', purpose: 'implement' });
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? '', /budget exceeded/i);
      assert.equal(tracker.sessionsUsed, 1); // rejected requests do not count
    });
  });

  describe('deep night (2 session limit)', () => {
    beforeEach(() => {
      tracker = new BudgetTracker({
        mode: 'deep',
        now: () => new Date('2026-04-10T23:00:00Z'),
      });
    });

    it('allows two sessions and refuses the third', () => {
      assert.equal(tracker.requestSession({ stage: 'improve', purpose: 'selection' }).allowed, true);
      assert.equal(tracker.requestSession({ stage: 'improve', purpose: 'implement' }).allowed, true);
      const third = tracker.requestSession({ stage: 'improve', purpose: 'fallback' });
      assert.equal(third.allowed, false);
    });
  });

  describe('emergency night (3 session limit)', () => {
    beforeEach(() => {
      tracker = new BudgetTracker({
        mode: 'emergency',
        now: () => new Date('2026-04-10T23:00:00Z'),
      });
    });

    it('allows three sessions and refuses the fourth', () => {
      for (let i = 0; i < 3; i++) {
        assert.equal(tracker.requestSession({ stage: 'improve', purpose: `s${i}` }).allowed, true);
      }
      const fourth = tracker.requestSession({ stage: 'improve', purpose: 'overflow' });
      assert.equal(fourth.allowed, false);
    });
  });

  describe('reset at 22:00 London', () => {
    it('resets counter when now() crosses the 22:00 London boundary', () => {
      // London is UTC+1 in April (BST). 22:00 BST == 21:00 UTC.
      let now = new Date('2026-04-10T20:00:00Z'); // 21:00 BST, before reset
      tracker = new BudgetTracker({ mode: 'cheap', now: () => now });
      tracker.requestSession({ stage: 'improve', purpose: 's1' });
      assert.equal(tracker.sessionsUsed, 1);

      // Advance past the 22:00 BST reset
      now = new Date('2026-04-10T21:30:00Z'); // 22:30 BST, after reset
      tracker.maybeReset();
      assert.equal(tracker.sessionsUsed, 0);
      const after = tracker.requestSession({ stage: 'improve', purpose: 's2' });
      assert.equal(after.allowed, true);
    });
  });

  describe('mode caps snapshot', () => {
    it('exposes the session cap for each mode', () => {
      assert.equal(new BudgetTracker({ mode: 'cheap' as BudgetNightMode }).sessionCap, 1);
      assert.equal(new BudgetTracker({ mode: 'deep' as BudgetNightMode }).sessionCap, 2);
      assert.equal(new BudgetTracker({ mode: 'emergency' as BudgetNightMode }).sessionCap, 3);
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/budget.test.ts
```

Expected: FAIL — `../budget.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/budget.ts`**

Create `src/overnight/budget.ts`:

```ts
// src/overnight/budget.ts — Opus session budget tracker for the overnight runner.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §5.5.
//
// A stage that wants to invoke Opus must call requestSession() first. Over-budget
// calls are refused (allowed:false) so the stage can record a skipped event.
// Counter resets at 22:00 London (the start of the overnight window).

export type BudgetNightMode = 'cheap' | 'deep' | 'emergency';

const MODE_CAPS: Readonly<Record<BudgetNightMode, number>> = Object.freeze({
  cheap: 1,
  deep: 2,
  emergency: 3,
});

export interface BudgetTrackerOptions {
  mode: BudgetNightMode;
  /** Override for tests. Defaults to Date.now-based. */
  now?: () => Date;
}

export interface SessionRequest {
  stage: string;
  purpose: string;
}

export interface SessionDecision {
  allowed: boolean;
  reason?: string;
}

export class BudgetTracker {
  private readonly mode: BudgetNightMode;
  private readonly nowFn: () => Date;
  private count = 0;
  private lastResetEpoch: number;

  constructor(opts: BudgetTrackerOptions) {
    this.mode = opts.mode;
    this.nowFn = opts.now ?? (() => new Date());
    this.lastResetEpoch = this.nightEpochFor(this.nowFn());
  }

  get sessionCap(): number {
    return MODE_CAPS[this.mode];
  }

  get sessionsUsed(): number {
    return this.count;
  }

  /**
   * Check whether the 22:00 London reset boundary has been crossed since the
   * last observation, and if so, zero the counter. Called automatically by
   * requestSession(); exposed for tests and for pre-stage introspection.
   */
  maybeReset(): void {
    const currentEpoch = this.nightEpochFor(this.nowFn());
    if (currentEpoch !== this.lastResetEpoch) {
      this.count = 0;
      this.lastResetEpoch = currentEpoch;
    }
  }

  requestSession(req: SessionRequest): SessionDecision {
    this.maybeReset();
    if (this.count >= this.sessionCap) {
      return {
        allowed: false,
        reason: `budget exceeded: ${this.mode} mode allows ${this.sessionCap} session(s), already used ${this.count} (request: ${req.stage}/${req.purpose})`,
      };
    }
    this.count += 1;
    return { allowed: true };
  }

  /**
   * Return an integer identifier for the "overnight window" that `at` falls in.
   * The window begins at 22:00 London local time. Dates before 22:00 London
   * belong to the previous day's window.
   */
  private nightEpochFor(at: Date): number {
    // Convert to London local time using Intl.
    const london = new Date(
      at.toLocaleString('en-US', { timeZone: 'Europe/London' }),
    );
    const hours = london.getHours();
    // "Night N" covers London [day N 22:00 → day N+1 22:00). Use day-of-year
    // plus year as an integer key.
    const dayStart = new Date(london);
    dayStart.setHours(22, 0, 0, 0);
    if (hours < 22) {
      // Still in the previous day's window.
      dayStart.setDate(dayStart.getDate() - 1);
    }
    return Math.floor(dayStart.getTime() / 1000);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
npx tsx --test src/overnight/__tests__/budget.test.ts
```

Expected: all tests pass. If the London reset test fails due to DST arithmetic, double-check the UTC offsets used in the test (BST = UTC+1 in April) and adjust the test fixture times rather than the implementation.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/overnight/budget.ts src/overnight/__tests__/budget.test.ts
git commit -m "feat(overnight): BudgetTracker with mode caps and London reset (spec §5.5)"
```

---

### Task 7: Tiering + banned files — `src/overnight/tiering.ts`

**Files:**
- Create: `src/overnight/tiering.ts`
- Create: `src/overnight/__tests__/tiering.test.ts`

Reason: spec §4.4 — "Banned file list lives in `src/overnight/tiering.js` and is read at gate-check time. The list is code-level, not prose-level, so the gate actually enforces it." Tier classifier decides whether a diff auto-merges or escalates to James.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/tiering.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, BANNED_FILES, type DiffSummary } from '../tiering.js';

describe('overnight/tiering', () => {
  describe('BANNED_FILES', () => {
    it('contains the files named in spec §4.4', () => {
      const expected = [
        'src/tasks/forge-orchestrator.js',
        'src/message-handler.js',
        'src/router.js',
        'src/cortex.js',
        'src/memory.js',
        'CLAUDE.md',
      ];
      for (const f of expected) assert.ok(BANNED_FILES.includes(f), `${f} should be banned`);
    });

    it('includes the docs/superpowers/** wildcard marker', () => {
      assert.ok(BANNED_FILES.some((f) => f.startsWith('docs/superpowers/')));
    });
  });

  describe('classifyTier', () => {
    it('Tier A: config/text/eval-labels only', () => {
      const diff: DiffSummary = {
        filesChanged: ['data/learned-eval-labels.json', 'src/prompt-templates/foo.txt'],
        linesChanged: 40,
      };
      assert.equal(classifyTier(diff).tier, 'A');
    });

    it('Tier B: source code within scope, no banned files', () => {
      const diff: DiffSummary = {
        filesChanged: ['src/overnight/report.ts', 'src/overnight/probe.ts'],
        linesChanged: 120,
      };
      assert.equal(classifyTier(diff).tier, 'B');
    });

    it('Tier C: exceeds file count', () => {
      const diff: DiffSummary = {
        filesChanged: [
          'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts',
        ],
        linesChanged: 50,
      };
      const result = classifyTier(diff);
      assert.equal(result.tier, 'C');
      assert.match(result.reason, /6 files.*max 5/);
    });

    it('Tier C: exceeds line count', () => {
      const diff: DiffSummary = {
        filesChanged: ['src/a.ts'],
        linesChanged: 200,
      };
      const result = classifyTier(diff);
      assert.equal(result.tier, 'C');
      assert.match(result.reason, /200 lines.*max 150/);
    });

    it('Tier C: touches a banned file', () => {
      const diff: DiffSummary = {
        filesChanged: ['src/overnight/report.ts', 'src/cortex.js'],
        linesChanged: 40,
      };
      const result = classifyTier(diff);
      assert.equal(result.tier, 'C');
      assert.match(result.reason, /banned.*src\/cortex\.js/);
    });

    it('Tier C: touches a docs/superpowers/ file', () => {
      const diff: DiffSummary = {
        filesChanged: ['docs/superpowers/specs/foo.md'],
        linesChanged: 10,
      };
      assert.equal(classifyTier(diff).tier, 'C');
    });

    it('Tier C: touches data/runtime/', () => {
      const diff: DiffSummary = {
        filesChanged: ['data/runtime/group-registry.json'],
        linesChanged: 5,
      };
      assert.equal(classifyTier(diff).tier, 'C');
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/tiering.test.ts
```

Expected: FAIL — `../tiering.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/tiering.ts`**

Create `src/overnight/tiering.ts`:

```ts
// src/overnight/tiering.ts — deterministic tier classifier for auto-deploy gates.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.4.
//
// Tier A  config/text/eval-labels/skill additions       → auto-merge on green CI
// Tier B  source changes ≤5 files ≤150 lines, no banned → auto-merge on CI+replay
// Tier C  anything else → opens a DM proposal card, never auto-merges

export const MAX_TIER_B_FILES = 5;
export const MAX_TIER_B_LINES = 150;

/**
 * Files the forge is NEVER allowed to modify via auto-deploy, even when every
 * gate would otherwise pass. This is the code-level banned list (spec §4.4).
 *
 * NOTE: prefix matches use isBannedPath(); exact paths are matched directly.
 */
export const BANNED_FILES: readonly string[] = Object.freeze([
  'src/tasks/forge-orchestrator.js',
  'src/message-handler.js',
  'src/router.js',
  'src/cortex.js',
  'src/memory.js',
  'CLAUDE.md',
  // Prefix markers: any path starting with these hits Tier C.
  'docs/superpowers/',
  'data/runtime/',
]);

export interface DiffSummary {
  filesChanged: string[];
  linesChanged: number;
}

export type Tier = 'A' | 'B' | 'C';

export interface TierClassification {
  tier: Tier;
  reason: string;
}

// Paths that count as "text/config/eval-labels" for Tier A.
const TIER_A_PREFIXES = [
  'data/learned-eval-labels.json',
  'data/prompts/',
  'src/prompt-templates/',
  'src/skills/',
] as const;

const TIER_A_EXTENSIONS = ['.json', '.txt', '.md', '.yaml', '.yml'] as const;

export function isBannedPath(path: string): boolean {
  for (const banned of BANNED_FILES) {
    if (banned.endsWith('/')) {
      if (path.startsWith(banned)) return true;
    } else if (path === banned) {
      return true;
    }
  }
  return false;
}

function isTierAPath(path: string): boolean {
  if (TIER_A_PREFIXES.some((p) => path.startsWith(p))) return true;
  // Top-level text files (e.g. README.md) — but CLAUDE.md is already banned above.
  return TIER_A_EXTENSIONS.some((ext) => path.endsWith(ext)) && !path.startsWith('src/');
}

export function classifyTier(diff: DiffSummary): TierClassification {
  // Banned files always win — check first.
  for (const f of diff.filesChanged) {
    if (isBannedPath(f)) {
      return { tier: 'C', reason: `banned path: ${f}` };
    }
  }

  // Pure Tier A if every file is Tier-A-shaped.
  if (diff.filesChanged.length > 0 && diff.filesChanged.every(isTierAPath)) {
    return { tier: 'A', reason: 'text/config/eval-labels only' };
  }

  // Tier B bounds.
  if (diff.filesChanged.length > MAX_TIER_B_FILES) {
    return {
      tier: 'C',
      reason: `${diff.filesChanged.length} files exceeds max ${MAX_TIER_B_FILES} for Tier B`,
    };
  }
  if (diff.linesChanged > MAX_TIER_B_LINES) {
    return {
      tier: 'C',
      reason: `${diff.linesChanged} lines exceeds max ${MAX_TIER_B_LINES} for Tier B`,
    };
  }

  return { tier: 'B', reason: `${diff.filesChanged.length} files, ${diff.linesChanged} lines, no banned paths` };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
npx tsx --test src/overnight/__tests__/tiering.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/overnight/tiering.ts src/overnight/__tests__/tiering.test.ts
git commit -m "feat(overnight): tier classifier + banned files list (spec §4.4)"
```

---

### Task 8: `withWorktree` helper — `src/overnight/worktree.ts`

**Files:**
- Create: `src/overnight/worktree.ts`
- Create: `src/overnight/__tests__/worktree.test.ts`

Reason: spec §5.2 — the single most important structural fix. No code-modifying phase operates on the main checkout. All such work goes through `withWorktree(fn)`.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/worktree.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWorktree, janitorSweep } from '../worktree.js';

// These tests stand up a fresh git repo in tmp and exercise real git worktree
// commands. They are slower than pure unit tests (~1-2s each) but the contract
// is inseparable from real git behaviour — mocking git would defeat the point.
describe('overnight/worktree', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'compound-dream-wt-'));
    execSync('git init -b main', { cwd: repoRoot });
    execSync('git config user.email "test@test.test"', { cwd: repoRoot });
    execSync('git config user.name "Test"', { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'file.txt'), 'initial\n');
    execSync('git add file.txt', { cwd: repoRoot });
    execSync('git commit -m init', { cwd: repoRoot });
  });

  afterEach(() => {
    try {
      execSync('git worktree prune', { cwd: repoRoot });
    } catch { /* ignore */ }
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('creates a worktree, runs the callback inside it, and removes it on success', async () => {
    let cbWorktreePath = '';

    await withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => {
      cbWorktreePath = wt.path;
      assert.ok(existsSync(wt.path), 'worktree directory should exist during callback');
      assert.ok(existsSync(join(wt.path, 'file.txt')), 'worktree should contain repo files');
      // Modify a file inside the worktree; main checkout should be unaffected.
      writeFileSync(join(wt.path, 'file.txt'), 'modified\n');
    });

    assert.ok(!existsSync(cbWorktreePath), 'worktree should be removed after callback');
    assert.equal(readFileSync(join(repoRoot, 'file.txt'), 'utf8'), 'initial\n');
  });

  it('removes the worktree even if the callback throws', async () => {
    let cbWorktreePath = '';

    await assert.rejects(
      withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => {
        cbWorktreePath = wt.path;
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.ok(!existsSync(cbWorktreePath), 'worktree should be removed after thrown error');
  });

  it('worktrees from different calls do not collide', async () => {
    const paths: string[] = [];
    await withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => { paths.push(wt.path); });
    await withWorktree({ repoRoot, baseRef: 'main' }, async (wt) => { paths.push(wt.path); });
    assert.equal(paths.length, 2);
    assert.notEqual(paths[0], paths[1]);
  });

  describe('janitorSweep', () => {
    it('removes orphaned worktrees from .worktrees/', async () => {
      // Manually create a stale worktree that never got cleaned up.
      const staleDir = join(repoRoot, '.worktrees', 'forge-stale');
      mkdirSync(join(repoRoot, '.worktrees'), { recursive: true });
      execSync(`git worktree add "${staleDir}" main`, { cwd: repoRoot });
      assert.ok(existsSync(staleDir));

      const swept = await janitorSweep({ repoRoot });
      assert.ok(swept >= 1, 'should have swept at least one worktree');
      assert.ok(!existsSync(staleDir));
    });

    it('returns 0 when there are no orphans', async () => {
      const swept = await janitorSweep({ repoRoot });
      assert.equal(swept, 0);
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/worktree.test.ts
```

Expected: FAIL — `../worktree.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/worktree.ts`**

Create `src/overnight/worktree.ts`:

```ts
// src/overnight/worktree.ts — withWorktree helper and janitor.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §5.2.
//
// Every overnight phase that modifies code MUST use withWorktree() so the
// main checkout is never touched. The helper creates a timestamped worktree
// under .worktrees/, runs the callback with the worktree's path, then
// removes the worktree whether the callback succeeds or throws.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const execFileP = promisify(execFile);

export interface WithWorktreeOptions {
  repoRoot: string;
  baseRef: string;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
}

/**
 * Create a fresh worktree at .worktrees/forge-<timestamp>, run fn(handle), and
 * remove the worktree on exit. Cleanup runs whether fn resolves or rejects.
 */
export async function withWorktree<T>(
  opts: WithWorktreeOptions,
  fn: (handle: WorktreeHandle) => Promise<T>,
): Promise<T> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .slice(0, 19);
  const wtPath = join(opts.repoRoot, '.worktrees', `forge-${timestamp}-${process.pid}`);
  const branch = `forge/wt-${timestamp}-${process.pid}`;

  await execFileP('git', ['worktree', 'add', '-b', branch, wtPath, opts.baseRef], {
    cwd: opts.repoRoot,
  });

  try {
    return await fn({ path: wtPath, branch });
  } finally {
    // Best-effort cleanup. We log but don't rethrow so the original fn error (if any) wins.
    try {
      await execFileP('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoRoot });
    } catch (err) {
      console.error(
        `withWorktree: failed to remove ${wtPath}: ${(err as Error).message} — janitorSweep will catch it later`,
      );
    }
    // Also delete the temporary branch we just created, best-effort.
    try {
      await execFileP('git', ['branch', '-D', branch], { cwd: opts.repoRoot });
    } catch {
      // intentional: branch may already be gone if worktree remove succeeded
    }
  }
}

/**
 * Sweep .worktrees/ for leftover directories from previous runs. Called at the
 * start of every overnight session before any new worktrees are created.
 *
 * Returns the number of worktrees removed.
 */
export async function janitorSweep(opts: { repoRoot: string }): Promise<number> {
  const dir = join(opts.repoRoot, '.worktrees');
  if (!existsSync(dir)) return 0;

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name));

  let removed = 0;
  for (const wt of entries) {
    try {
      await execFileP('git', ['worktree', 'remove', '--force', wt], { cwd: opts.repoRoot });
      removed += 1;
    } catch (err) {
      console.error(
        `janitorSweep: failed to remove ${wt}: ${(err as Error).message}`,
      );
    }
  }

  // Tell git to drop stale administrative records.
  try {
    await execFileP('git', ['worktree', 'prune'], { cwd: opts.repoRoot });
  } catch {
    // intentional: prune is housekeeping only
  }

  return removed;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
npx tsx --test src/overnight/__tests__/worktree.test.ts
```

Expected: all tests pass. These are slower than the other Phase 0 tests (real git) — budget ~5 seconds total for the whole file.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/overnight/worktree.ts src/overnight/__tests__/worktree.test.ts
git commit -m "feat(overnight): withWorktree + janitorSweep (spec §5.2)"
```

---

### Task 9: Runner skeleton — `src/overnight/runner.ts`

**Files:**
- Create: `src/overnight/runner.ts`
- Create: `src/overnight/__tests__/runner.test.ts`

Reason: spec §3 — "A single `src/overnight/runner.js` takes over, declared once in `scheduler.js`." Phase 0 ships only the skeleton: stage declarations, budget enforcement, synthetic failure events, janitor sweep. The actual stage bodies (consolidate, probe, report, improve) are implemented in Phases 1-4 and wired in by overriding the skeleton's stage registry.

- [ ] **Step 1: Write the failing test**

Create `src/overnight/__tests__/runner.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvernightRunner } from '../runner.js';
import { queryEvents } from '../events.js';

describe('overnight/runner.OvernightRunner (skeleton)', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-runner-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs a registered stage and records the event it produces', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      // Skip janitor in tests so it doesn't try to find git.
      skipJanitor: true,
    });

    runner.register('consolidate', async (ctx) => {
      await ctx.appendEvent({
        stage: 'consolidate',
        phase: 'extract',
        inputs: [],
        outputs: ['memory:x'],
        verdict: 'ok',
        reason: 'extracted 1 entry',
        evidence_refs: ['sha256:a'],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 42 },
      });
    });

    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.stage, 'consolidate');
    assert.equal(events[0]!.phase, 'extract');
  });

  it('writes a synthetic "failed: no event produced" event when a stage completes without writing one', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    runner.register('probe', async () => {
      // intentionally writes no event
    });

    await runner.run(['probe']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verdict, 'failed');
    assert.match(events[0]!.reason, /no event produced/i);
  });

  it('writes a synthetic "failed" event when a stage throws', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    runner.register('report', async () => {
      throw new Error('simulated stage failure');
    });

    await runner.run(['report']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verdict, 'failed');
    assert.match(events[0]!.reason, /simulated stage failure/);
  });

  it('refuses to over-run budget and records skipped event', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap', // cap = 1
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    runner.register('improve', async (ctx) => {
      const first = ctx.budget.requestSession({ stage: 'improve', purpose: 'selection' });
      assert.equal(first.allowed, true);
      const second = ctx.budget.requestSession({ stage: 'improve', purpose: 'implement' });
      assert.equal(second.allowed, false);
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'selection',
        inputs: [],
        outputs: [],
        verdict: 'skipped',
        reason: second.reason ?? 'budget',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 1, tokens: 0 },
      });
    });

    await runner.run(['improve']);
    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verdict, 'skipped');
  });

  it('rejects unknown stage names in the run list', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    await assert.rejects(
      () => runner.run(['bogus' as unknown as 'consolidate']),
      /stage "bogus" is not registered/,
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
npx tsx --test src/overnight/__tests__/runner.test.ts
```

Expected: FAIL — `../runner.js` does not exist.

- [ ] **Step 3: Implement `src/overnight/runner.ts`**

Create `src/overnight/runner.ts`:

```ts
// src/overnight/runner.ts — overnight orchestrator skeleton.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §3, §5.4, §5.5.
//
// Phase 0 ships the skeleton only. Stage bodies live in Phases 1-4 and are
// plugged in via runner.register(stage, fn). The skeleton enforces:
//   - budget tracking (via BudgetTracker)
//   - "no event = did not happen" synthetic failure events
//   - janitor sweep of stale worktrees before any stage runs
//   - unknown stage rejection
//
// This file intentionally contains no stage business logic.

import { appendEvent, queryEvents, type OvernightEvent, type OvernightStage } from './events.js';
import { BudgetTracker, type BudgetNightMode } from './budget.js';
import { janitorSweep } from './worktree.js';

export interface StageContext {
  stage: OvernightStage;
  date: string;
  overnightDir: string;
  repoRoot: string;
  budget: BudgetTracker;
  appendEvent: (event: Omit<OvernightEvent, 'id' | 'timestamp'>) => Promise<OvernightEvent>;
}

export type StageFn = (ctx: StageContext) => Promise<void>;

export interface OvernightRunnerOptions {
  mode: BudgetNightMode;
  date: string; // YYYY-MM-DD
  overnightDir: string;
  repoRoot: string;
  now?: () => Date;
  skipJanitor?: boolean;
}

export class OvernightRunner {
  private readonly opts: Required<Omit<OvernightRunnerOptions, 'now' | 'skipJanitor'>> & {
    now: () => Date;
    skipJanitor: boolean;
  };
  private readonly stages = new Map<OvernightStage, StageFn>();
  readonly budget: BudgetTracker;

  constructor(opts: OvernightRunnerOptions) {
    this.opts = {
      mode: opts.mode,
      date: opts.date,
      overnightDir: opts.overnightDir,
      repoRoot: opts.repoRoot,
      now: opts.now ?? (() => new Date()),
      skipJanitor: opts.skipJanitor ?? false,
    };
    this.budget = new BudgetTracker({ mode: opts.mode, now: this.opts.now });
  }

  register(stage: OvernightStage, fn: StageFn): void {
    this.stages.set(stage, fn);
  }

  async run(order: OvernightStage[]): Promise<void> {
    // Reject unknown stages before doing any work.
    for (const s of order) {
      if (!this.stages.has(s)) {
        throw new Error(`stage "${s}" is not registered`);
      }
    }

    if (!this.opts.skipJanitor) {
      try {
        await janitorSweep({ repoRoot: this.opts.repoRoot });
      } catch (err) {
        // intentional: janitor failure is not fatal, just record and continue
        console.error(`runner: janitorSweep failed: ${(err as Error).message}`);
      }
    }

    for (const stage of order) {
      await this.runStage(stage);
    }
  }

  private async runStage(stage: OvernightStage): Promise<void> {
    const fn = this.stages.get(stage)!; // Existence already checked in run()
    const eventsBefore = await queryEvents({
      date: this.opts.date,
      stage,
      overnightDir: this.opts.overnightDir,
    });
    const beforeCount = eventsBefore.length;

    const ctx: StageContext = {
      stage,
      date: this.opts.date,
      overnightDir: this.opts.overnightDir,
      repoRoot: this.opts.repoRoot,
      budget: this.budget,
      appendEvent: (event) => appendEvent(event, {
        date: this.opts.date,
        overnightDir: this.opts.overnightDir,
      }),
    };

    try {
      await fn(ctx);
    } catch (err) {
      await appendEvent(
        {
          stage,
          phase: 'runner',
          inputs: [],
          outputs: [],
          verdict: 'failed',
          reason: `stage threw: ${(err as Error).message}`,
          evidence_refs: [],
          rollback_ref: null,
          budget: { opus_sessions: 0, tokens: 0 },
        },
        { date: this.opts.date, overnightDir: this.opts.overnightDir },
      );
      return;
    }

    const eventsAfter = await queryEvents({
      date: this.opts.date,
      stage,
      overnightDir: this.opts.overnightDir,
    });
    if (eventsAfter.length === beforeCount) {
      await appendEvent(
        {
          stage,
          phase: 'runner',
          inputs: [],
          outputs: [],
          verdict: 'failed',
          reason: 'no event produced — treating as silent failure (spec §5.4)',
          evidence_refs: [],
          rollback_ref: null,
          budget: { opus_sessions: 0, tokens: 0 },
        },
        { date: this.opts.date, overnightDir: this.opts.overnightDir },
      );
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
npx tsx --test src/overnight/__tests__/runner.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/overnight/runner.ts src/overnight/__tests__/runner.test.ts
git commit -m "feat(overnight): OvernightRunner skeleton with synthetic-failure guard (spec §3, §5.4)"
```

---

### Task 10: Full verification pass

**Files:** none modified.

Reason: ensure Phase 0 leaves the codebase in a green state. Any regression here stops Phase 1 before it starts.

- [ ] **Step 1: Run the overnight test folder**

Run:
```bash
npx tsx --test src/overnight/__tests__/*.test.ts
```

Expected: all tests in `paths`, `events`, `budget`, `tiering`, `worktree`, `runner` pass. Total runtime should be under 30 seconds (worktree tests dominate).

- [ ] **Step 2: Run the full project test suite**

Run:
```bash
npm test
```

Expected: pre-existing tests continue to pass. No new failures introduced by the Phase 0 changes. If any existing test fails, diagnose before Phase 1 starts — candidate causes include:

- `src/group-registry.js` / `src/system-knowledge.js` / `src/tools/projects.js` path change broke a caller that hardcoded the old path somewhere Phase 0 didn't touch. Fix by routing that caller through the updated helper.
- Renormalisation in Task 1 Step 2 changed a fixture file's SHA (possible if any test snapshots track file content). Regenerate the fixture with LF content.

- [ ] **Step 3: Sanity-check the live bot path on EVO**

This step is manual. After the Phase 0 commits are pushed to main and pulled on EVO, restart the bot with:

```bash
ssh james@100.90.66.54 'cd ~/clawdbot && git pull && sudo systemctl restart clawdbot && sleep 5 && sudo systemctl status clawdbot --no-pager | head -20'
```

Expected: the `clawdbot` systemd service is `active (running)` with no startup errors. If group-registry / system-knowledge / projects readers regressed, the service log will show the failure — roll back the path changes for that specific helper and reopen as a targeted follow-up before proceeding to Phase 1.

- [ ] **Step 4: Smoke-test a runtime-state round-trip on EVO**

Still manual. Send yourself a DM that triggers a group-registry read (e.g., ask the bot to list registered groups). The response should include the expected groups. Then register a new test group (e.g., `/register test` if such a command exists, or equivalent) and verify the file at `data/runtime/group-registry.json` has been updated. If it has been written to the new location, the P1 relocation is complete.

- [ ] **Step 5: Final commit marker**

No files change. Leave a note in the commit history so the phase is traceable:

Run:
```bash
git commit --allow-empty -m "chore(overnight): Phase 0 preconditions + shared infrastructure complete

Spec:  docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md
Plan:  docs/superpowers/plans/2026-04-10-compound-dream-phase0-preconditions.md

Lays the foundation for Phase 1 (CONSOLIDATE). No stage logic yet;
existing overnight pipeline is unchanged and still runs."
```

Expected: an empty commit marking the phase boundary.

---

## Out-of-band notes for the executing agent

1. **Do not attempt to delete or edit the existing overnight pipeline in Phase 0.** `forge-orchestrator.js`, `overnight-report.js`, `improvement-cycle.js`, `weekly-retrospective.js`, `overnight-to-evolution.js`, and the `evolution*.js` family are all retired in Phase 5, not Phase 0. They must remain runnable through Phases 0-4 so that the bot keeps producing morning reports on its current schedule while the new pipeline is built alongside.

2. **Phase 0 touches no scheduler entries.** The `src/overnight/runner.ts` skeleton is built but never invoked. Wiring it into `src/scheduler.js` happens in Phase 1 once there is at least one real stage to run.

3. **If Task 3 (runtime-state relocation) blocks on the LQCore decision**, skip ahead to Tasks 5-9 (events, budget, tiering, worktree, runner). Those tasks are independent and can land first. Task 3 + Task 4 together can then land once the LQCore answer is in.

4. **Windows CRLF warnings** during Tasks 5-9 are expected until Task 1's `.gitattributes` is active and the normalisation from Task 1 Step 2 has been committed. Running Task 1 before the helper tasks avoids a noisy second renormalisation later.

5. **Task 8 (worktree) stands up a real git repo in a tmp dir.** On CI or constrained environments this may need `git config --global user.email/name` available system-wide. The test sets repo-local config, so system config is not required.

6. **The `runtimePath()` helper is deliberately synchronous** even though the rest of `src/overnight/` is async. The live bot loads runtime-state files at startup via synchronous readers; making `runtimePath()` async would force a cascade of refactors across `group-registry.js`, `system-knowledge.js`, and `projects.js` that is out of scope for Phase 0.

---

## Phase 0 → Phase 1 handoff

After Phase 0 is complete the tree has:

- `.gitattributes` forcing LF; CRLF noise gone going forward.
- `data/runtime/` holding live-bot state; `data/runtime-defaults/` seeding fresh clones.
- `src/overnight/{paths,events,budget,tiering,worktree,runner}.ts` with full test coverage.
- A working runner skeleton with no registered stages — safe to invoke, produces no events, enforces its own invariants.
- The old overnight pipeline still running untouched.

Phase 1 (CONSOLIDATE) will then:
- Implement `src/overnight/consolidate.ts` that replaces the current nightly dream-extraction cycle.
- Wire the first real stage into `OvernightRunner` via `runner.register('consolidate', consolidateStage)`.
- Add scheduler entry that invokes `runner.run(['consolidate'])` at 22:05 London, replacing the current `improvement-cycle.js` schedule entry only once the new stage has run green for three consecutive nights alongside the old one.

*End of Phase 0 plan.*
