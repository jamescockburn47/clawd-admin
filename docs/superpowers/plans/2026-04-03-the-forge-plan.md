# The Forge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragmented overnight pipeline with The Forge — an autonomous skill factory that uses Opus via Max subscription to compose new capabilities, auto-deploy safe changes, and recursively improve itself.

**Architecture:** Pi orchestrator assembles intelligence from local data, calls EVO's 30B for analysis, then runs Opus via Claude Code CLI for architect/implement/review phases. Skills are self-contained JS modules auto-discovered by a registry. Post-processing hooks in message-handler.js invoke skills after response generation.

**Tech Stack:** Node.js 20+ ESM, Claude Code CLI (Opus via Max), EVO 30B (Qwen3-Coder), `node --test` for testing, existing eval framework.

---

### Task 1: Skill Contract and Registry

**Files:**
- Create: `src/skills/.gitkeep`
- Create: `src/skills/__tests__/.gitkeep`
- Create: `src/skill-registry.js`
- Create: `src/skills/__tests__/registry.test.js`
- Create: `src/skills/example-skill.js` (reference implementation)

- [ ] **Step 1: Create directories**

```bash
mkdir -p src/skills/__tests__
touch src/skills/.gitkeep src/skills/__tests__/.gitkeep
```

- [ ] **Step 2: Write the skill registry test**

Create `src/skills/__tests__/registry.test.js`:

```js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadSkills, getActiveSkills, getSkillsForMessage, describeCapabilities } from '../../skill-registry.js';

describe('skill-registry', () => {
  beforeEach(async () => {
    await loadSkills();
  });

  it('discovers skills from src/skills/', async () => {
    const skills = getActiveSkills();
    assert.ok(Array.isArray(skills));
    assert.ok(skills.length >= 1, 'should find at least the example skill');
  });

  it('each skill has required contract fields', () => {
    for (const skill of getActiveSkills()) {
      assert.ok(skill.name, `skill missing name`);
      assert.ok(skill.description, `${skill.name} missing description`);
      assert.ok(typeof skill.canHandle === 'function', `${skill.name} missing canHandle()`);
      assert.ok(typeof skill.execute === 'function', `${skill.name} missing execute()`);
      assert.ok(skill.selfExplanation, `${skill.name} missing selfExplanation`);
    }
  });

  it('getSkillsForMessage returns matching skills', () => {
    const msg = { text: 'test message', category: 'general_knowledge' };
    const context = { responseLength: 300, isGroup: false };
    const matching = getSkillsForMessage(msg, context);
    assert.ok(Array.isArray(matching));
  });

  it('describeCapabilities returns natural language', () => {
    const desc = describeCapabilities();
    assert.ok(typeof desc === 'string');
    assert.ok(desc.length > 0);
  });

  it('disabled skills are excluded from matching', async () => {
    const skills = getActiveSkills();
    if (skills.length === 0) return; // skip if no skills
    const first = skills[0];
    first._disabled = true;
    const msg = { text: 'test', category: 'general_knowledge' };
    const matching = getSkillsForMessage(msg, { responseLength: 300, isGroup: false });
    const found = matching.find(s => s.name === first.name);
    assert.equal(found, undefined, 'disabled skill should not match');
    first._disabled = false; // restore
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test src/skills/__tests__/registry.test.js
```

Expected: FAIL — `skill-registry.js` does not exist.

- [ ] **Step 4: Create the example skill**

Create `src/skills/example-skill.js`:

```js
// src/skills/example-skill.js — Reference implementation of the skill contract.
// The Forge uses this as a pattern when composing new skills.

export default {
  name: 'example-skill',
  description: 'Reference skill — does nothing, demonstrates the contract',
  version: 1,
  created: '2026-04-03',
  author: 'human',

  triggers: {
    categories: [],
    conditions: 'never triggers — reference only'
  },

  canHandle(_msg, _context) {
    return false; // never triggers
  },

  execute(_msg, _context) {
    return null; // no-op
  },

  selfExplanation: 'I am a reference skill that demonstrates the skill contract. I never trigger.',
  examples: [],

  metrics: {
    timesTriggered: 0,
    timesHelpful: 0,
    lastTriggered: null,
  }
};
```

- [ ] **Step 5: Implement the skill registry**

Create `src/skill-registry.js`:

```js
// src/skill-registry.js — Auto-discovers skill modules in src/skills/,
// exposes query interface for message handler and self-knowledge.

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, 'skills');

const skills = [];

export async function loadSkills() {
  skills.length = 0;
  let files;
  try {
    files = readdirSync(SKILLS_DIR).filter(f => f.endsWith('.js') && !f.startsWith('_'));
  } catch {
    logger.warn('skill-registry: src/skills/ not found or unreadable');
    return;
  }

  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(join(SKILLS_DIR, file)).href);
      const skill = mod.default;
      if (!skill?.name || typeof skill.canHandle !== 'function') {
        logger.warn({ file }, 'skill-registry: invalid skill contract, skipping');
        continue;
      }
      if (!skill.metrics) skill.metrics = { timesTriggered: 0, timesHelpful: 0, lastTriggered: null };
      skills.push(skill);
      logger.info({ name: skill.name, author: skill.author }, 'skill-registry: loaded');
    } catch (err) {
      logger.error({ file, err: err.message }, 'skill-registry: failed to load skill');
    }
  }
}

export function getActiveSkills() {
  return skills.filter(s => !s._disabled);
}

export function getSkillsForMessage(msg, context) {
  return getActiveSkills().filter(skill => {
    try {
      return skill.canHandle(msg, context);
    } catch (err) {
      logger.warn({ skill: skill.name, err: err.message }, 'skill canHandle() threw');
      return false;
    }
  });
}

export async function runSkillPostProcessors(response, msg, context) {
  const matching = getSkillsForMessage(msg, context);
  let enriched = response;

  for (const skill of matching) {
    try {
      const result = await skill.execute(msg, { ...context, response: enriched });
      if (typeof result === 'string' && result.length > 0) {
        enriched = result;
      }
      skill.metrics.timesTriggered++;
      skill.metrics.lastTriggered = new Date().toISOString();
    } catch (err) {
      logger.warn({ skill: skill.name, err: err.message }, 'skill execute() threw');
      // Skill failure is silent — original response preserved
    }
  }

  return enriched;
}

export function describeCapabilities() {
  const active = getActiveSkills().filter(s => s.author === 'forge');
  if (active.length === 0) return 'No forge-created skills active yet.';

  const lines = active.map(s => `- ${s.selfExplanation}`);
  return `I have ${active.length} learned skill(s):\n${lines.join('\n')}`;
}

export function getForgeHistory() {
  return getActiveSkills()
    .filter(s => s.author === 'forge')
    .map(s => ({
      name: s.name,
      description: s.description,
      created: s.created,
      version: s.version,
      metrics: { ...s.metrics },
    }));
}

export function disableSkill(name) {
  const skill = skills.find(s => s.name === name);
  if (skill) {
    skill._disabled = true;
    logger.info({ name }, 'skill-registry: skill disabled');
    return true;
  }
  return false;
}

export function enableSkill(name) {
  const skill = skills.find(s => s.name === name);
  if (skill) {
    skill._disabled = false;
    logger.info({ name }, 'skill-registry: skill enabled');
    return true;
  }
  return false;
}
```

- [ ] **Step 6: Run tests**

```bash
node --test src/skills/__tests__/registry.test.js
```

Expected: All 5 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/skills/ src/skill-registry.js
git commit -m "feat: skill registry with auto-discovery and example skill"
```

---

### Task 2: Wire Skills into Message Handler

**Files:**
- Modify: `src/message-handler.js` (around line 400-410)
- Modify: `src/index.js` (startup — load skills)

- [ ] **Step 1: Read current message-handler.js lines 390-420**

Identify the exact insertion point between `getClawdResponse()` and `filterResponse()`.

- [ ] **Step 2: Add skill registry import to message-handler.js**

At the top imports section, add:

```js
import { getSkillsForMessage, runSkillPostProcessors } from './skill-registry.js';
```

- [ ] **Step 3: Insert skill post-processing hook**

After the line where `response` is assigned from `getClawdResponse()` and BEFORE `filterResponse()`, insert:

```js
    // ── Skill post-processing hooks ──
    let processedResponse = response;
    try {
      const skillContext = {
        responseLength: response.length,
        isGroup: chatJid.endsWith('@g.us'),
        category: routingResult?.category,
        chatJid,
      };
      processedResponse = await runSkillPostProcessors(response, { text: triggerText, category: routingResult?.category }, skillContext);
    } catch (err) {
      logger.warn({ err: err.message }, 'skill post-processing failed, using original response');
    }
```

Then change the `filterResponse` call to use `processedResponse` instead of `response`.

- [ ] **Step 4: Load skills at startup in index.js**

Add to the startup sequence (after `loadBuffers()`, before `initScheduler()`):

```js
import { loadSkills } from './skill-registry.js';
// ... in startup:
await loadSkills();
logger.info('skill registry loaded');
```

- [ ] **Step 5: Verify Node.js syntax check passes**

```bash
node --check src/message-handler.js && node --check src/index.js
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/message-handler.js src/index.js
git commit -m "feat: wire skill post-processing into message handler"
```

---

### Task 3: Forge Data Directory and Initial Prompts

**Files:**
- Create: `data/forge/specs/.gitkeep`
- Create: `data/forge/reports/.gitkeep`
- Create: `data/forge/meta/.gitkeep`
- Create: `data/forge/prompts/architect.md`
- Create: `data/forge/prompts/reviewer.md`
- Create: `data/forge/prompts/analyst.md`
- Create: `data/forge/prompts/tester.md`
- Create: `data/forge/prompts/skill-contract.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p data/forge/specs data/forge/reports data/forge/meta data/forge/prompts
touch data/forge/specs/.gitkeep data/forge/reports/.gitkeep data/forge/meta/.gitkeep
```

- [ ] **Step 2: Write the analyst prompt**

Create `data/forge/prompts/analyst.md`:

```markdown
# Forge Analyst — Intelligence Gathering Prompt

You are the intelligence gathering engine for The Forge, Clawd's autonomous overnight improvement system.

Your job: analyse today's data and produce Tonight's Brief — a ranked list of improvement opportunities.

## Priority Order
1. **Skill opportunities** — new capabilities Clawd doesn't have yet (highest priority)
2. **Skill enhancements** — existing skills that could be better based on usage data
3. **Bug fixes / accuracy improvements** — things that are broken or miscategorised
4. **Meta-improvements** — ways to improve the Forge's own prompts, tests, or eval suite

## What Makes a Good Skill Opportunity
- Pattern appears in conversation logs: user repeatedly needs something Clawd can't do
- High-frequency scenario where Clawd's response is adequate but could be enhanced
- Cross-cutting capability that would help across multiple categories
- Evidence-grounded: cite specific messages/traces, not speculation

## What Makes a Good Meta-Opportunity
- Eval suite has low coverage for a category (< 20 test cases)
- Previous Forge specs led to implementation failures (anti-pattern to add)
- Previous Forge specs led to clean first-try implementations (pattern to extract)
- Auto-deploy decisions that were wrong (tighten or loosen criteria)

## Output Format
Respond with JSON only. Schema:
{
  "date": "YYYY-MM-DD",
  "opportunities": [{ rank, title, category, evidence, impact, suggested_approach, files_likely, auto_deployable, estimated_complexity }],
  "eval_baseline": { keyword, needsPlan_f1, writeIntent },
  "meta_opportunities": [{ title, reason }],
  "skill_opportunities": [{ title, evidence, pattern }],
  "health_summary": "good|fair|poor — one sentence"
}
```

- [ ] **Step 3: Write the architect prompt**

Create `data/forge/prompts/architect.md`:

```markdown
# Forge Architect — Spec Writing Prompt

You are the architect for The Forge. You receive an opportunity from the analyst and produce a detailed, implementable spec.

## Spec Requirements
- Every spec must have measurable success criteria (eval scores, test counts, trigger rates)
- Every spec must list exact files to create/modify
- Every spec must follow TDD: tests written first, implementation second
- Every spec must classify itself as auto-deployable or needs-approval

## Skill Specs
For new skills, the spec must include:
- The skill contract fields (name, description, triggers, canHandle logic, execute logic)
- selfExplanation text (how Clawd describes this skill to the user)
- At least 6 positive and 6 negative test cases for canHandle()
- At least 3 test cases for execute() output shape
- Integration smoke test plan (which real messages to test against)

## Auto-Deploy Classification
Auto-deployable (ALL must be true):
- Max 3 existing files modified (new files in src/skills/ don't count)
- Max 80 lines changed in existing files
- No new dependencies
- Only touches src/, eval/, src/skills/
- Has measurable success criteria
- Risk: low

Needs approval (ANY triggers):
- Modifies message-handler.js, router.js, classifier, index.js, or tool handlers
- Changes system prompts or personality
- Touches soul system
- Risk: medium or high

## Output Format
Respond with JSON only. Schema:
{
  "title": "string",
  "goal": "string",
  "success_criteria": ["string"],
  "steps": ["string"],
  "files_new": ["path"],
  "files_modified": ["path"],
  "estimated_lines": number,
  "auto_deploy_classification": { "verdict": "auto-deploy|needs-approval", "reasoning": "string" }
}
```

- [ ] **Step 4: Write the reviewer prompt**

Create `data/forge/prompts/reviewer.md`:

```markdown
# Forge Reviewer — Code Review Prompt

You are reviewing code produced by The Forge's implementation phase. You have NO context from the coding session — only the spec, the diff, and the test results.

## Review Checklist
1. Do all tests pass?
2. Does the diff match the spec's declared files?
3. Does the skill conform to the contract (name, canHandle, execute, selfExplanation)?
4. Is there any eval regression > 2%?
5. Are there any banned files touched?
6. Could this change break existing message handling?
7. Is this actually an IMPROVEMENT? (DGM gate — correct but useless = reject)

## Verdict Rules
- "auto-deploy": all checks pass AND architect classified as auto-deploy AND change is genuinely useful
- "needs-approval": some checks pass but scope/risk warrants human review
- "reject": tests fail, regressions detected, or change isn't an improvement

## Output Format
JSON only:
{
  "verdict": "auto-deploy|needs-approval|reject",
  "confidence": 0.0-1.0,
  "checks": { tests_pass, eval_no_regression, diff_within_bounds, skill_contract_valid, no_banned_files_touched, no_side_effects, code_quality },
  "override_architect": null|"escalate"|"approve",
  "summary": "string",
  "concerns": ["string"],
  "improvement_notes": "string"
}
```

- [ ] **Step 5: Write the tester prompt**

Create `data/forge/prompts/tester.md`:

```markdown
# Forge Tester — Test Generation Prompt

You are generating tests for a new skill. Tests must be thorough enough that passing them guarantees the skill works correctly.

## Test Structure (node:test)
- Use `import { describe, it } from 'node:test'` and `import assert from 'node:assert/strict'`
- Group by: canHandle() positive cases, canHandle() negative cases, execute() output shape
- Each test should be independent — no shared mutable state

## canHandle() Tests (minimum 12)
- 6 positive: messages that SHOULD trigger the skill, covering different phrasings
- 6 negative: messages that should NOT trigger (greetings, wrong category, too short, group messages if DM-only)

## execute() Tests (minimum 3)
- Output is a string (enriched response) or null (no-op)
- Output contains the original response content (augmentation, not replacement)
- Output doesn't contain banned patterns (emoji, filler, preamble)

## Integration Test (1)
- Import the skill AND the registry
- Verify the skill appears in getActiveSkills() after loadSkills()
```

- [ ] **Step 6: Write the skill contract reference**

Create `data/forge/prompts/skill-contract.md`:

```markdown
# Clawd Skill Contract

Every skill in src/skills/ must export a default object with these fields:

## Required Fields
- `name` (string) — kebab-case identifier, unique across all skills
- `description` (string) — one sentence explaining what the skill does
- `version` (number) — integer, incremented on enhancement
- `created` (string) — ISO date when first created
- `author` (string) — 'forge' for auto-created, 'human' for manually written
- `canHandle(msg, context)` (function) — returns true if this skill should run
  - msg: { text, category }
  - context: { responseLength, isGroup, chatJid }
- `execute(msg, context)` (function) — returns enriched response string or null
  - context includes `response` (the current response text to augment)
- `selfExplanation` (string) — how Clawd describes this skill conversationally
- `examples` (string[]) — 1-3 concrete examples of the skill in action

## Optional Fields
- `triggers.categories` (string[]) — which classifier categories this skill activates for
- `triggers.conditions` (string) — human-readable description of trigger logic
- `metrics` (object) — { timesTriggered, timesHelpful, lastTriggered } — auto-tracked

## Rules
- Skills AUGMENT responses, they don't replace them
- A skill returning null or throwing means the original response is used unchanged
- Skills must not call external APIs or modify files — they are pure response enrichment
- Skills must not import from message-handler.js, router.js, or claude.js (no circular deps)
- Skills CAN import from config.js, constants.js, logger.js, memory.js (read-only queries)
```

- [ ] **Step 7: Commit**

```bash
git add data/forge/
git commit -m "feat: Forge data directory and initial prompts"
```

---

### Task 4: Forge Orchestrator

**Files:**
- Create: `src/tasks/forge-orchestrator.js`
- Modify: `src/scheduler.js` (wire in at 22:30)

- [ ] **Step 1: Write the orchestrator**

Create `src/tasks/forge-orchestrator.js`:

```js
// src/tasks/forge-orchestrator.js — The Forge: autonomous overnight skill factory.
//
// Orchestrates: intelligence gathering (30B) -> architect (Opus) -> implement (Opus)
// -> review (Opus) -> deploy/queue -> meta-improvement -> report.
//
// Runs on Pi. SSH to EVO for Claude Code CLI phases.
// Replaces: overnight-coder.py, evo-evolve, self-improve cycle, weekly-retrospective.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';
import logger from '../logger.js';
import { evoFetch, llamaBreaker } from '../evo-client.js';
import { createTask, canRunTask, updateTask, getNextPending } from '../evolution.js';
import { loadSkills } from '../skill-registry.js';

const exec = promisify(execCb);

const FORGE_DIR = join('data', 'forge');
const SPECS_DIR = join(FORGE_DIR, 'specs');
const REPORTS_DIR = join(FORGE_DIR, 'reports');
const META_DIR = join(FORGE_DIR, 'meta');
const PROMPTS_DIR = join(FORGE_DIR, 'prompts');
const HISTORY_FILE = join(FORGE_DIR, 'history.jsonl');

const HARD_STOP_HOUR = 5;
const HARD_STOP_MINUTE = 15;
const PHASE_TIMEOUT_MS = {
  analysis: 30 * 60_000,
  architect: 30 * 60_000,
  implement: 2 * 60 * 60_000,
  review: 30 * 60_000,
  meta: 60 * 60_000,
};

let lastForgeDate = null;

// ── Entry point (called by scheduler at 22:30) ─────────────────────────────

export async function checkForge(sendFn, todayStr, hours, minutes) {
  if (lastForgeDate === todayStr) return;
  if (hours !== 22 || minutes < 30) return;

  lastForgeDate = todayStr;
  ensureDirs();

  const session = {
    date: todayStr,
    startedAt: new Date().toISOString(),
    phases: {},
    tasks: [],
    errors: [],
  };

  try {
    logger.info('forge: === THE FORGE BEGINS ===');

    // Phase 1: Intelligence Gathering
    if (isPastHardStop()) return saveReport(session, sendFn);
    session.phases.analysis = { startedAt: new Date().toISOString() };
    const brief = await withTimeout(gatherIntelligence(todayStr), PHASE_TIMEOUT_MS.analysis);
    session.phases.analysis.completedAt = new Date().toISOString();
    session.phases.analysis.brief = brief;

    if (!brief || (!brief.skill_opportunities?.length && !brief.opportunities?.length)) {
      logger.info('forge: no actionable opportunities tonight');
      session.phases.analysis.result = 'no opportunities';
      return saveReport(session, sendFn);
    }

    // Pick primary task: skill opportunities first, then general opportunities
    const primaryOpp = brief.skill_opportunities?.[0] || brief.opportunities?.[0];
    const metaOpp = brief.meta_opportunities?.[0] || null;

    // Phase 2: Architect
    if (isPastHardStop()) return saveReport(session, sendFn);
    session.phases.architect = { startedAt: new Date().toISOString() };
    const spec = await withTimeout(runArchitect(primaryOpp, brief), PHASE_TIMEOUT_MS.architect);
    session.phases.architect.completedAt = new Date().toISOString();
    session.phases.architect.spec = spec;

    if (!spec) {
      session.phases.architect.result = 'failed to produce spec';
      session.errors.push('Architect failed to produce valid spec');
    }

    // Phase 3: Implement + Test
    let implResult = null;
    if (spec && !isPastHardStop()) {
      session.phases.implement = { startedAt: new Date().toISOString() };
      implResult = await withTimeout(runImplementation(spec, todayStr), PHASE_TIMEOUT_MS.implement);
      session.phases.implement.completedAt = new Date().toISOString();
      session.phases.implement.result = implResult;
    }

    // Phase 4: Review
    let verdict = null;
    if (implResult?.success && !isPastHardStop()) {
      session.phases.review = { startedAt: new Date().toISOString() };
      verdict = await withTimeout(runReview(spec, implResult), PHASE_TIMEOUT_MS.review);
      session.phases.review.completedAt = new Date().toISOString();
      session.phases.review.verdict = verdict;
    }

    // Phase 5: Deploy or Queue
    if (verdict && !isPastHardStop()) {
      const deployResult = await handleDeployDecision(spec, implResult, verdict, sendFn);
      session.tasks.push({
        title: spec.title,
        verdict: verdict.verdict,
        deployed: deployResult.deployed,
        taskId: deployResult.taskId,
      });
    }

    // Phase 6: Meta-improvement
    if (metaOpp && !isPastHardStop()) {
      session.phases.meta = { startedAt: new Date().toISOString() };
      const metaResult = await withTimeout(runMetaImprovement(metaOpp, brief), PHASE_TIMEOUT_MS.meta);
      session.phases.meta.completedAt = new Date().toISOString();
      session.phases.meta.result = metaResult;
    }

    // Greedy: if time remains, pick next opportunity
    if (!isPastHardStop() && brief.opportunities?.length > 1) {
      logger.info('forge: time remaining, considering second task');
      // Future: implement second task loop
    }

  } catch (err) {
    logger.error({ err: err.message }, 'forge: session failed');
    session.errors.push(err.message);
  }

  // Phase 7: Report
  await saveReport(session, sendFn);
}

export function getLastForgeDate() { return lastForgeDate; }

// ── Phase 1: Intelligence Gathering ─────────────────────────────────────────

async function gatherIntelligence(todayStr) {
  logger.info('forge: Phase 1 — Intelligence Gathering');

  // Assemble inputs from local data files
  const inputs = {};

  // Trace analysis
  const traceFile = join('data', 'trace-analysis.json');
  if (existsSync(traceFile)) {
    try { inputs.traceAnalysis = JSON.parse(readFileSync(traceFile, 'utf-8')); } catch {}
  }

  // Today's conversation logs
  const logDir = join('data', 'conversation-logs');
  if (existsSync(logDir)) {
    const logFiles = readdirSync(logDir).filter(f => f.startsWith(todayStr));
    inputs.conversationSummary = `${logFiles.length} conversation logs from today`;
    // Read a sample for the analyst
    if (logFiles.length > 0) {
      try {
        const sample = readFileSync(join(logDir, logFiles[0]), 'utf-8')
          .split('\n').filter(Boolean).slice(-50).join('\n');
        inputs.conversationSample = sample;
      } catch {}
    }
  }

  // Previous Forge reports
  if (existsSync(REPORTS_DIR)) {
    const reports = readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json')).sort().slice(-3);
    inputs.previousReports = reports.map(f => {
      try { return JSON.parse(readFileSync(join(REPORTS_DIR, f), 'utf-8')); } catch { return null; }
    }).filter(Boolean);
  }

  // Skill metrics
  const { getForgeHistory } = await import('../skill-registry.js');
  inputs.skillMetrics = getForgeHistory();

  // Self-improvement history
  const improveLog = join('data', 'self-improve-log.jsonl');
  if (existsSync(improveLog)) {
    const lines = readFileSync(improveLog, 'utf-8').trim().split('\n').filter(Boolean);
    inputs.selfImproveHistory = lines.slice(-5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // Run eval baseline
  let evalBaseline = {};
  try {
    const { runFullEval } = await import('../../eval/router-eval.js');
    evalBaseline = await runFullEval();
  } catch (err) {
    logger.warn({ err: err.message }, 'forge: eval baseline failed');
  }
  inputs.evalBaseline = evalBaseline;

  // Load analyst prompt
  const analystPrompt = readFileSync(join(PROMPTS_DIR, 'analyst.md'), 'utf-8');

  // Call 30B on EVO
  try {
    const result = await llamaBreaker.call(async () => {
      const res = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { role: 'system', content: analystPrompt },
            { role: 'user', content: `Today's data:\n${JSON.stringify(inputs, null, 2)}\n\nProduce Tonight's Brief. JSON only. /no_think` },
          ],
          temperature: 0.3,
          max_tokens: 3000,
        }),
        timeout: PHASE_TIMEOUT_MS.analysis,
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim();
    }, null);

    if (!result) return null;
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'forge: intelligence gathering LLM failed');
    return null;
  }
}

// ── Phase 2: Architect ──────────────────────────────────────────────────────

async function runArchitect(opportunity, brief) {
  logger.info({ title: opportunity.title }, 'forge: Phase 2 — Architect');

  const architectPrompt = readFileSync(join(PROMPTS_DIR, 'architect.md'), 'utf-8');
  const skillContract = readFileSync(join(PROMPTS_DIR, 'skill-contract.md'), 'utf-8');

  // Run Opus via Claude Code CLI on EVO
  const prompt = [
    architectPrompt,
    '\n## Skill Contract Reference\n',
    skillContract,
    '\n## Tonight\'s Opportunity\n',
    JSON.stringify(opportunity, null, 2),
    '\n## Eval Baseline\n',
    JSON.stringify(brief.eval_baseline, null, 2),
    '\n\nProduce a detailed spec. JSON only.',
  ].join('\n');

  try {
    const result = await runClaudeCodeOnEvo(prompt);
    if (!result) return null;
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const spec = JSON.parse(jsonMatch[0]);

    // Save spec
    const specFile = join(SPECS_DIR, `${brief.date}-task-1.json`);
    writeFileSync(specFile, JSON.stringify(spec, null, 2));
    logger.info({ title: spec.title }, 'forge: spec saved');
    return spec;
  } catch (err) {
    logger.error({ err: err.message }, 'forge: architect failed');
    return null;
  }
}

// ── Phase 3: Implement + Test ───────────────────────────────────────────────

async function runImplementation(spec, todayStr) {
  logger.info({ title: spec.title }, 'forge: Phase 3 — Implement + Test');

  const skillContract = readFileSync(join(PROMPTS_DIR, 'skill-contract.md'), 'utf-8');
  const testerPrompt = readFileSync(join(PROMPTS_DIR, 'tester.md'), 'utf-8');

  // Read example skill for reference
  let exampleSkill = '';
  try { exampleSkill = readFileSync(join('src', 'skills', 'example-skill.js'), 'utf-8'); } catch {}

  const prompt = [
    '# Forge Implementation Task',
    '',
    '## Spec',
    JSON.stringify(spec, null, 2),
    '',
    '## Skill Contract',
    skillContract,
    '',
    '## Test Generation Guidelines',
    testerPrompt,
    '',
    '## Example Skill (reference pattern)',
    '```js',
    exampleSkill,
    '```',
    '',
    '## Instructions',
    'Follow TDD strictly:',
    '1. Write tests first in src/skills/__tests__/',
    '2. Run tests to verify they fail',
    '3. Implement the skill in src/skills/',
    '4. Register in src/skill-registry.js (add import + push to skills array — OR the registry auto-discovers, just create the file)',
    '5. Run tests to verify they pass',
    '6. Run: node eval/router-eval.js — verify no regression',
    '7. Commit to a new branch: forge/' + spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
    '',
    'If tests fail, fix the implementation (not the tests). Max 3 attempts.',
    'The skill registry auto-discovers .js files in src/skills/ — no manual registration needed.',
  ].join('\n');

  try {
    const result = await runClaudeCodeOnEvo(prompt, { branch: `forge/${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}` });

    // Check if implementation succeeded by looking for the branch + test results
    const branchCheck = await sshEvo(`cd ~/clawdbot && git branch --list 'forge/*' | head -5`);
    const testResult = await sshEvo(`cd ~/clawdbot && node --test src/skills/__tests__/ 2>&1 | tail -20`);

    return {
      success: !testResult.includes('failing') && !testResult.includes('FAIL'),
      branch: branchCheck.trim(),
      testOutput: testResult,
      claudeOutput: result?.slice(0, 2000),
    };
  } catch (err) {
    logger.error({ err: err.message }, 'forge: implementation failed');
    return { success: false, error: err.message };
  }
}

// ── Phase 4: Review ─────────────────────────────────────────────────────────

async function runReview(spec, implResult) {
  logger.info({ title: spec.title }, 'forge: Phase 4 — Review');

  const reviewerPrompt = readFileSync(join(PROMPTS_DIR, 'reviewer.md'), 'utf-8');

  // Get the diff from EVO
  const diff = await sshEvo(`cd ~/clawdbot && git diff main...HEAD --stat && echo '---DIFF---' && git diff main...HEAD`);

  const prompt = [
    reviewerPrompt,
    '',
    '## Original Spec',
    JSON.stringify(spec, null, 2),
    '',
    '## Test Results',
    implResult.testOutput,
    '',
    '## Git Diff',
    diff.slice(0, 8000),
    '',
    'Produce your verdict. JSON only.',
  ].join('\n');

  try {
    const result = await runClaudeCodeOnEvo(prompt, { freshSession: true });
    if (!result) return null;
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'forge: review failed');
    return null;
  }
}

// ── Phase 5: Deploy Decision ────────────────────────────────────────────────

async function handleDeployDecision(spec, implResult, verdict, sendFn) {
  const shouldAutoDeploy =
    verdict.verdict === 'auto-deploy' &&
    verdict.checks?.tests_pass &&
    verdict.checks?.eval_no_regression &&
    spec.auto_deploy_classification?.verdict === 'auto-deploy';

  if (shouldAutoDeploy) {
    logger.info({ title: spec.title }, 'forge: auto-deploying');
    try {
      // Merge on EVO
      await sshEvo(`cd ~/clawdbot && git checkout main && git merge --no-ff ${implResult.branch} -m "forge: ${spec.title}"`);
      // Rsync to Pi
      await exec(`scp -i ~/.ssh/id_ed25519 -r pi@${config.evoDirectIp || '10.0.0.2'}:~/clawdbot/src/skills/ src/skills/`);
      // Reload skills
      await loadSkills();
      logger.info({ title: spec.title }, 'forge: auto-deploy complete');
      logHistory({ action: 'auto-deploy', title: spec.title, verdict: verdict.verdict });
      return { deployed: true, taskId: null };
    } catch (err) {
      logger.error({ err: err.message }, 'forge: auto-deploy failed, reverting');
      await sshEvo(`cd ~/clawdbot && git reset --hard HEAD~1`).catch(() => {});
      logHistory({ action: 'auto-deploy-failed', title: spec.title, error: err.message });
      return { deployed: false, taskId: null };
    }
  } else {
    // Queue for morning approval via evolution system
    const task = createTask(
      `[FORGE] ${spec.title}: ${spec.goal}`,
      'forge',
      'normal'
    );
    if (sendFn) {
      const msg = [
        `*FORGE — Awaiting Approval*`,
        `Task: ${spec.title}`,
        `Goal: ${spec.goal}`,
        `Reviewer: ${verdict.summary}`,
        verdict.concerns?.length ? `Concerns: ${verdict.concerns.join(', ')}` : '',
        '',
        `Reply *approve* to deploy or *reject* to discard.`,
      ].filter(Boolean).join('\n');
      await sendFn(msg);
    }
    logHistory({ action: 'queued-approval', title: spec.title, taskId: task.id });
    return { deployed: false, taskId: task.id };
  }
}

// ── Phase 6: Meta-Improvement ───────────────────────────────────────────────

async function runMetaImprovement(metaOpp, brief) {
  logger.info({ title: metaOpp.title }, 'forge: Phase 6 — Meta-Improvement');

  const prompt = [
    '# Forge Meta-Improvement Task',
    '',
    '## Opportunity',
    JSON.stringify(metaOpp, null, 2),
    '',
    '## Context',
    `Eval baseline: ${JSON.stringify(brief.eval_baseline)}`,
    '',
    '## Instructions',
    'Implement this meta-improvement. You may:',
    '- Add test cases to eval/router-eval.js or eval/needsplan-eval.js',
    '- Modify prompts in data/forge/prompts/',
    '- Add test fixtures',
    '',
    'You may NOT modify src/ files for meta-improvements.',
    'Commit changes to main directly (meta-improvements are always safe).',
  ].join('\n');

  try {
    const result = await runClaudeCodeOnEvo(prompt);
    return { success: true, output: result?.slice(0, 1000) };
  } catch (err) {
    logger.error({ err: err.message }, 'forge: meta-improvement failed');
    return { success: false, error: err.message };
  }
}

// ── Phase 7: Report ─────────────────────────────────────────────────────────

async function saveReport(session, sendFn) {
  session.completedAt = new Date().toISOString();

  // Save full report
  const reportFile = join(REPORTS_DIR, `${session.date}.json`);
  writeFileSync(reportFile, JSON.stringify(session, null, 2));
  logger.info({ file: reportFile }, 'forge: report saved');

  // Generate WhatsApp summary
  if (sendFn) {
    const lines = ['*THE FORGE — Overnight Report*', ''];

    for (const task of session.tasks) {
      if (task.deployed) {
        lines.push(`*Deployed:* ${task.title}`);
      } else if (task.taskId) {
        lines.push(`*Awaiting Approval:* ${task.title}`);
      } else {
        lines.push(`*${task.verdict}:* ${task.title}`);
      }
    }

    if (session.tasks.length === 0) {
      lines.push('No tasks completed tonight.');
      if (session.errors.length > 0) {
        lines.push(`Errors: ${session.errors.join('; ')}`);
      }
    }

    if (session.phases.meta?.result?.success) {
      lines.push('', '*Meta-improvement applied.*');
    }

    const duration = session.completedAt && session.startedAt
      ? Math.round((new Date(session.completedAt) - new Date(session.startedAt)) / 60000)
      : '?';
    lines.push('', `Session: ${duration} min | Errors: ${session.errors.length}`);

    await sendFn(lines.join('\n'));
  }

  logHistory({ action: 'session-complete', date: session.date, tasks: session.tasks.length, errors: session.errors.length });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function runClaudeCodeOnEvo(prompt, opts = {}) {
  const tmpFile = '/tmp/forge-prompt.md';
  // Write prompt to EVO via SSH
  const escaped = prompt.replace(/'/g, "'\\''");
  await sshEvo(`cat > ${tmpFile} << 'FORGE_EOF'\n${prompt}\nFORGE_EOF`);

  const flags = [
    '-p',
    '--model claude-opus-4-6',
    '--allowedTools "Edit,Write,Read,Bash,Glob,Grep"',
  ];

  if (opts.branch) {
    await sshEvo(`cd ~/clawdbot && git checkout -b ${opts.branch} 2>/dev/null || git checkout ${opts.branch}`);
  }

  const cmd = `cd ~/clawdbot && claude ${flags.join(' ')} < ${tmpFile}`;
  const result = await sshEvo(cmd, { timeout: PHASE_TIMEOUT_MS.implement });
  return result;
}

async function sshEvo(cmd, opts = {}) {
  const timeout = opts.timeout || 300_000;
  const sshCmd = `ssh -i ~/.ssh/id_ed25519 -o ConnectTimeout=10 james@10.0.0.2 '${cmd.replace(/'/g, "'\\''")}'`;
  const { stdout, stderr } = await exec(sshCmd, { timeout });
  if (stderr && !stderr.includes('Warning')) {
    logger.debug({ stderr: stderr.slice(0, 200) }, 'forge: ssh stderr');
  }
  return stdout;
}

function isPastHardStop() {
  const now = new Date();
  const london = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const h = parseInt(london.find(p => p.type === 'hour').value, 10);
  const m = parseInt(london.find(p => p.type === 'minute').value, 10);
  return (h > HARD_STOP_HOUR) || (h === HARD_STOP_HOUR && m >= HARD_STOP_MINUTE);
}

function ensureDirs() {
  for (const dir of [FORGE_DIR, SPECS_DIR, REPORTS_DIR, META_DIR, PROMPTS_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

function logHistory(entry) {
  appendFileSync(HISTORY_FILE, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n');
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Phase timeout after ${ms}ms`)), ms)),
  ]);
}
```

- [ ] **Step 2: Wire into scheduler**

Modify `src/scheduler.js`:

Add import:
```js
import { checkForge, getLastForgeDate } from './tasks/forge-orchestrator.js';
```

Add to `runScheduler()` after `checkWeeklyRetrospective`:
```js
  await runTask('forge', () => checkForge(sendFn, todayStr, hours, minutes));
```

Add to `getSystemHealth()`:
```js
    forge: { enabled: true, lastRun: getLastForgeDate() },
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/tasks/forge-orchestrator.js && node --check src/scheduler.js
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/tasks/forge-orchestrator.js src/scheduler.js
git commit -m "feat: Forge orchestrator — multi-phase overnight skill factory"
```

---

### Task 5: Update Systemd Timer for Forge

**Files:**
- Modify: `pi-system/overnight-coder.service` (point to Forge instead)
- Create: `pi-system/forge.service`

- [ ] **Step 1: Create Forge systemd service**

The Forge runs via the Node.js scheduler (integrated into clawdbot), not as a separate Python process. The existing `overnight-coder.timer` at 22:30 should be disabled. The scheduler handles the 22:30 trigger internally.

Create `pi-system/forge.md` (documentation, not a service file):

```markdown
# The Forge — No Separate Service Required

The Forge runs inside clawdbot's scheduler at 22:30 London time.
No separate systemd timer needed — the scheduler calls checkForge() every minute
and it activates at 22:30.

To disable the old overnight coder:
  sudo systemctl disable overnight-coder.timer
  sudo systemctl stop overnight-coder.timer

The evo-evolve.timer (22:05) should also be disabled:
  sudo systemctl disable evo-evolve.timer
  sudo systemctl stop evo-evolve.timer

Both are replaced by the Forge orchestrator in src/tasks/forge-orchestrator.js.
```

- [ ] **Step 2: Commit**

```bash
git add pi-system/forge.md
git commit -m "docs: Forge replaces overnight-coder and evo-evolve timers"
```

---

### Task 6: Self-Knowledge Integration

**Files:**
- Modify: `src/tools/handler.js` (add skill query tool)
- Modify: `src/system-knowledge.js` or equivalent (dynamic capabilities)

- [ ] **Step 1: Read src/tools/handler.js to find where tools are defined**

Identify the tool definitions section and the pattern for adding new tools.

- [ ] **Step 2: Add a `list_skills` tool response**

In the system knowledge / self-awareness handler, when Clawd is asked about capabilities, include output from `describeCapabilities()`:

```js
import { describeCapabilities, getForgeHistory } from '../skill-registry.js';

// In the system knowledge response builder:
const skillsSection = describeCapabilities();
const forgeHistory = getForgeHistory();
const recentSkills = forgeHistory.length > 0
  ? forgeHistory.map(s => `${s.name} (v${s.version}, created ${s.created})`).join(', ')
  : 'none yet';
```

Add to the system knowledge response:
```
Learned skills: ${recentSkills}
${skillsSection}
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/handler.js
git commit -m "feat: self-knowledge includes learned skills from registry"
```

---

### Task 7: Update CLAUDE.md and Constants

**Files:**
- Modify: `CLAUDE.md` (add Forge design decisions)
- Modify: `src/constants.js` (add Forge-related constants)

- [ ] **Step 1: Add Forge constants**

Add to `src/constants.js`:

```js
// Forge (overnight skill factory)
export const FORGE = {
  PHASE_TIMEOUT_ANALYSIS: 30 * 60_000,
  PHASE_TIMEOUT_ARCHITECT: 30 * 60_000,
  PHASE_TIMEOUT_IMPLEMENT: 2 * 60 * 60_000,
  PHASE_TIMEOUT_REVIEW: 30 * 60_000,
  PHASE_TIMEOUT_META: 60 * 60_000,
  HARD_STOP_HOUR: 5,
  HARD_STOP_MINUTE: 15,
  START_HOUR: 22,
  START_MINUTE: 30,
  AUTO_DEPLOY_MAX_EXISTING_FILES: 3,
  AUTO_DEPLOY_MAX_LINES: 80,
};
```

- [ ] **Step 2: Add CLAUDE.md design decisions**

Add to Design Decisions section:

```markdown
### The Forge (2026-04-03)
150. **The Forge replaces all overnight coding.** overnight-coder.py, evo-evolve, self-improve cycle, weekly-retrospective all replaced by forge-orchestrator.js.
151. **Skills are the primary output.** New capabilities as src/skills/ modules, not bug fixes. Skill contract: name, canHandle(), execute(), selfExplanation.
152. **Skill registry auto-discovers.** src/skill-registry.js scans src/skills/*.js at startup. No manual registration.
153. **Skills are post-processing hooks.** Inserted after getClawdResponse(), before filterResponse(). Augment, never replace.
154. **Opus via Max subscription for all Forge coding.** Free on Max plan. No MiniMax for evolution.
155. **Staged autonomy.** New skills auto-deploy (additive, sandboxed). Existing file modifications need approval.
156. **Three-gate validation.** Architect classifies + tests pass + reviewer validates. All three for auto-deploy.
157. **DGM evolutionary gate.** Changes must be improvements, not just correct.
158. **Recursive meta-improvement.** Forge improves its own prompts in data/forge/prompts/.
159. **Self-knowledge is live.** Capabilities query from skill registry, not static JSON.
160. **Orchestrator is human-only.** forge-orchestrator.js cannot be modified by the Forge.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/constants.js
git commit -m "feat: Forge constants and design decisions"
```

---

### Task 8: Integration Test — Dry Run

**Files:**
- Create: `eval/forge-smoke.js` (integration smoke test)

- [ ] **Step 1: Write the smoke test**

Create `eval/forge-smoke.js`:

```js
// eval/forge-smoke.js — Smoke test for The Forge infrastructure.
// Verifies: skill registry loads, skills conform to contract, post-processing hook works.
// Run: node eval/forge-smoke.js

import { loadSkills, getActiveSkills, getSkillsForMessage, runSkillPostProcessors, describeCapabilities } from '../src/skill-registry.js';

async function main() {
  console.log('=== FORGE SMOKE TEST ===\n');
  let pass = 0;
  let fail = 0;

  // Test 1: Registry loads
  try {
    await loadSkills();
    const skills = getActiveSkills();
    console.log(`[PASS] Registry loaded: ${skills.length} skill(s)`);
    pass++;
  } catch (err) {
    console.log(`[FAIL] Registry load: ${err.message}`);
    fail++;
  }

  // Test 2: All skills conform to contract
  const skills = getActiveSkills();
  for (const skill of skills) {
    const required = ['name', 'description', 'canHandle', 'execute', 'selfExplanation'];
    const missing = required.filter(f => !skill[f]);
    if (missing.length === 0) {
      console.log(`[PASS] ${skill.name}: contract valid`);
      pass++;
    } else {
      console.log(`[FAIL] ${skill.name}: missing ${missing.join(', ')}`);
      fail++;
    }
  }

  // Test 3: Post-processing with no matching skills returns original
  try {
    const original = 'Test response';
    const result = await runSkillPostProcessors(original, { text: 'hello', category: 'conversational' }, { responseLength: 13, isGroup: false });
    if (result === original) {
      console.log('[PASS] No matching skills: original response preserved');
      pass++;
    } else {
      console.log(`[FAIL] Expected original response, got: ${result.slice(0, 50)}`);
      fail++;
    }
  } catch (err) {
    console.log(`[FAIL] Post-processing: ${err.message}`);
    fail++;
  }

  // Test 4: describeCapabilities works
  try {
    const desc = describeCapabilities();
    if (typeof desc === 'string' && desc.length > 0) {
      console.log(`[PASS] describeCapabilities: "${desc.slice(0, 60)}..."`);
      pass++;
    } else {
      console.log('[FAIL] describeCapabilities returned empty');
      fail++;
    }
  } catch (err) {
    console.log(`[FAIL] describeCapabilities: ${err.message}`);
    fail++;
  }

  // Test 5: Forge data directories exist
  const { existsSync } = await import('fs');
  const dirs = ['data/forge/specs', 'data/forge/reports', 'data/forge/meta', 'data/forge/prompts'];
  for (const dir of dirs) {
    if (existsSync(dir)) {
      console.log(`[PASS] ${dir} exists`);
      pass++;
    } else {
      console.log(`[FAIL] ${dir} missing`);
      fail++;
    }
  }

  // Test 6: Forge prompts exist
  const prompts = ['analyst.md', 'architect.md', 'reviewer.md', 'tester.md', 'skill-contract.md'];
  for (const prompt of prompts) {
    if (existsSync(`data/forge/prompts/${prompt}`)) {
      console.log(`[PASS] Prompt: ${prompt}`);
      pass++;
    } else {
      console.log(`[FAIL] Missing prompt: ${prompt}`);
      fail++;
    }
  }

  console.log(`\n=== RESULTS: ${pass} pass, ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
```

- [ ] **Step 2: Run the smoke test**

```bash
node eval/forge-smoke.js
```

Expected: All tests PASS (after Tasks 1-3 are complete).

- [ ] **Step 3: Commit**

```bash
git add eval/forge-smoke.js
git commit -m "test: Forge smoke test — registry, contract, post-processing"
```

---

### Task 9: Deploy and Verify

- [ ] **Step 1: Run full syntax check**

```bash
node --check src/skill-registry.js && \
node --check src/tasks/forge-orchestrator.js && \
node --check src/message-handler.js && \
node --check src/scheduler.js && \
echo "All files pass"
```

- [ ] **Step 2: Run eval suite (no regression)**

```bash
node eval/router-eval.js
node eval/forge-smoke.js
```

Expected: All PASS, no regressions.

- [ ] **Step 3: Deploy to Pi**

```bash
scp -i ~/.ssh/id_ed25519 src/skill-registry.js src/message-handler.js src/scheduler.js src/index.js src/constants.js pi@192.168.1.211:~/clawdbot/src/
scp -i ~/.ssh/id_ed25519 src/tasks/forge-orchestrator.js pi@192.168.1.211:~/clawdbot/src/tasks/
scp -i ~/.ssh/id_ed25519 -r src/skills/ pi@192.168.1.211:~/clawdbot/src/skills/
scp -i ~/.ssh/id_ed25519 eval/forge-smoke.js pi@192.168.1.211:~/clawdbot/eval/
scp -i ~/.ssh/id_ed25519 -r data/forge/ pi@192.168.1.211:~/clawdbot/data/forge/
scp -i ~/.ssh/id_ed25519 CLAUDE.md pi@192.168.1.211:~/clawdbot/
```

- [ ] **Step 4: Restart and verify**

```bash
ssh pi@192.168.1.211 "sudo systemctl restart clawdbot && sleep 3 && sudo systemctl status clawdbot | head -15"
```

- [ ] **Step 5: Run smoke test on Pi**

```bash
ssh pi@192.168.1.211 "cd ~/clawdbot && node eval/forge-smoke.js"
```

- [ ] **Step 6: Disable old overnight timers on Pi**

```bash
ssh pi@192.168.1.211 "sudo systemctl disable overnight-coder.timer && sudo systemctl stop overnight-coder.timer"
```

- [ ] **Step 7: Final commit**

```bash
git add -A && git commit -m "feat: The Forge — complete deployment"
```
