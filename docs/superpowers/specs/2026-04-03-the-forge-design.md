# The Forge — Autonomous Recursive Self-Improvement for Clawd

> Spec date: 2026-04-03
> Status: Draft — awaiting approval
> Author: James Cockburn + Claude Opus 4.6

## 1. Overview

The Forge is a nightly autonomous improvement session that runs on EVO, orchestrated from the Pi. It replaces the current fragmented overnight pipeline (overnight-coder.py, evo-evolve, self-improve cycle) with a single coordinated multi-agent session powered by Opus via Claude Max subscription.

**Core innovation:** The Forge is a skill factory. Instead of fixing bugs and tuning classifiers, it composes genuinely new capabilities as self-contained skill modules. Clawd wakes up smarter every morning — and can explain what it learned.

**Recursive property:** The Forge improves its own architect prompts, review criteria, test generation, and intelligence gathering. Each night's session is more discerning than the last.

**Prior art borrowed from:**
- Sakana AI's Darwin Godel Machine: evolutionary keep-what-works/discard-what-doesn't
- Karpathy's AutoResearch Loop: tight experiment-measure-keep/discard cycle
- Meta's HyperAgents: meta-agent that improves the task agent's own code

**What makes this novel:** No one has shipped a production personal assistant that composes new skills overnight, auto-deploys safe changes, and recursively improves its own improvement process. This would be the first.

## 2. Architecture

### Nightly Flow (Event-Driven, Not Clock-Driven)

Each phase starts when the previous finishes. No fixed time boxes.

```
22:00  Model swap: VL-30B -> Coder (existing, unchanged)
22:05  Dream mode runs (existing, unchanged)
22:30  THE FORGE BEGINS
       |
       Phase 1: Intelligence Gathering (local 30B)
       |  Reads traces, diary, code quality, conversation logs, previous Forge reports
       |  Produces "Tonight's Brief" — ranked opportunities + meta-opportunities
       |  Timeout: 30 min safety net (typically 5-10 min)
       |
       Phase 2: Architect (Opus via Claude Code CLI)
       |  Reads brief + relevant source files
       |  Writes detailed spec for #1 opportunity
       |  Classifies as auto-deployable vs needs-approval
       |  Saves spec to data/forge/specs/
       |
       Phase 3: Implement + Test (Opus via Claude Code CLI)
       |  TDD: write tests first, implement, iterate up to 3 fix cycles
       |  Run full eval suite, verify no regression
       |  Integration smoke test with real messages
       |  Commit to forge/ branch
       |
       Phase 4: Review (Fresh Opus session, no shared context)
       |  Validates diff against spec
       |  DGM-style gate: "is this an improvement?" not just "is this correct?"
       |  Produces structured verdict
       |
       Phase 5: Deploy or Queue
       |  Auto-deploy if safe + tests pass + reviewer approves
       |  Otherwise queue for morning approval via WhatsApp
       |  Health check with auto-revert on failure
       |
       Phase 6: Meta-Improvement (Opus)
       |  Second task: improve eval suite, Forge prompts, test generation
       |  Always auto-deployable (eval/prompt-only changes)
       |
       Phase 7: Report
       |  Generate overnight report with full audit trail
       |  WhatsApp summary to James
       |
05:15  HARD STOP (before overnight report at 05:30, model swap at 06:00)
```

**Hard constraints:**
- Pause window: 01:50-02:25 for memory extraction (only affects local 30B, not Opus)
- Hard stop: 05:15
- Per-phase timeout: 30 min (analysis), 2 hours (implementation), 30 min (review)

**Greedy scheduling:** The Forge fills the overnight window. If primary task finishes fast, meta-improvement starts sooner. If meta finishes early, pick up opportunity #2 from the brief.

### Three Tiers of Work

**Tier 1: New Skills** — compose genuinely new capabilities as skill modules. The "wow" factor.

**Tier 2: Skill Enhancement** — improve existing skills based on usage metrics. Compounding quality.

**Tier 3: Meta-Improvement** — improve the Forge's own prompts, criteria, and test generation. Recursive.

## 3. The Skill System

### Skill Contract

Every skill is a JS module in `src/skills/` that exports:

```js
export default {
  // Identity
  name: 'smart-follow-up',
  description: 'After answering a substantive question, generates 2-3 follow-up questions',
  version: 1,
  created: '2026-04-03',
  author: 'forge',           // 'forge' or 'human'

  // Trigger conditions
  triggers: {
    categories: ['legal', 'planning', 'general_knowledge'],
    conditions: 'response length > 200 chars AND not a greeting'
  },

  // Core interface
  canHandle(msg, context) { /* return true/false */ },
  execute(msg, context) { /* return enriched response or side-effect */ },

  // Self-knowledge (Clawd uses these to explain itself)
  selfExplanation: 'I can suggest follow-up questions after giving you a detailed answer.',
  examples: [
    'After explaining a limitation period, I might ask: "Need the CPR deadline calculation too?"'
  ],

  // Runtime metrics (updated by the system)
  metrics: {
    timesTriggered: 0,
    timesHelpful: 0,
    lastTriggered: null,
  }
}
```

### Skill Registry

`src/skill-registry.js` auto-discovers all modules in `src/skills/`:

- `getActiveSkills()` — all loaded skills
- `getSkillsForMessage(msg, context)` — which skills want to handle this message
- `describeCapabilities()` — natural language summary for self-knowledge
- `getForgeHistory()` — what was added/improved and when

### Self-Knowledge Integration

Static `system-knowledge.json` keeps identity, architecture, personality (human-maintained). Capabilities section becomes a **live query** to the skill registry.

When asked "what can you do?" or "what did you learn?":
1. Identity and personality from system-knowledge.json (static)
2. Capabilities dynamically generated from skill registry
3. Recent improvements from `data/forge/reports/` (last 7 nights)

Clawd can say: "Last night I learned to suggest follow-up questions after detailed answers. The night before, I got better at weaving relevant memories into responses. The follow-up skill has triggered 12 times today."

### Skill Lifecycle

```
Forge creates skill -> auto-deployed -> registry loads it
  -> triggers in conversation -> metrics tracked
  -> next Forge session reads metrics
  -> if timesTriggered=0 after 3 days: flag for review/removal
  -> if timesHelpful high: enhance in Tier 2
  -> if timesHelpful low: refine triggers or improve execution
```

### How Skills Integrate with Message Flow

Skills are **post-processing hooks**, not alternative response generators. The message handler flow becomes:

```
message in -> classifier -> router -> LLM generates response
  -> skill registry: getSkillsForMessage(msg, context)
  -> for each matching skill: skill.execute(msg, { response, context })
  -> skill may: append follow-up questions, enrich with memory context,
     log quality signals, trigger side-effects (e.g., proactive DM later)
  -> final response sent
```

Skills cannot replace the main response — they augment it. A skill that returns nothing is a no-op. This means a broken skill produces at worst a normal response with no augmentation, not a broken response.

### Owner Authority (CLAUDE.md Rule 32)

James overrides any skill via WhatsApp:
- "disable smart-follow-up" -> skill stays but canHandle() returns false
- "that follow-up was annoying" -> logged as negative signal, Forge adjusts
- "I want a skill that does X" -> logged as Forge task, picked up next night

## 4. Phase Details

### Phase 1: Intelligence Gathering

**Executor:** Local 30B on EVO (free, analysis only).

**Inputs:**
1. Trace analysis (`data/trace-analysis.json`)
2. Tonight's dream diary (what happened in conversations today)
3. Code quality report (`data/overnight-results/code-quality.json`)
4. Full conversation logs (today's JSONL — all messages, not just bot)
5. Self-improvement history (`data/self-improve-log.jsonl`)
6. Previous Forge reports (`data/forge/reports/` — last 3 nights)
7. Skill registry metrics (which skills trigger, which are dead)
8. Eval baseline (current scores)

**Output:** Tonight's Brief (structured JSON):

```json
{
  "date": "2026-04-03",
  "opportunities": [
    {
      "rank": 1,
      "title": "Router misclassifies multi-step travel requests",
      "category": "accuracy",
      "evidence": "3 traces show travel+calendar queries routed as single-tool",
      "impact": "high",
      "suggested_approach": "Add needsPlan rules for compound queries",
      "files_likely": ["src/router.js", "eval/needsplan-eval.js"],
      "auto_deployable": true,
      "estimated_complexity": "small"
    }
  ],
  "eval_baseline": { "keyword": 94.2, "needsPlan_f1": 78.5, "writeIntent": 100 },
  "meta_opportunities": [
    {
      "title": "needsPlan eval only has 24 test cases",
      "reason": "Low coverage means we can't trust F1 improvements"
    }
  ],
  "skill_opportunities": [
    {
      "title": "Smart follow-up after substantive answers",
      "evidence": "James asked 4 follow-up questions manually this week",
      "pattern": "After long legal/planning answers, user always needs more"
    }
  ],
  "health_summary": "fair"
}
```

**Selection:** Orchestrator picks primary task (highest-impact) + meta task. Skill opportunities take priority over bug fixes — the goal is new capabilities, not maintenance.

**Fallback:** If 30B is unavailable, read trace analysis JSON directly and generate a formulaic brief. The Forge must never fail to start because of Phase 1.

### Phase 2: Architect

**Executor:** Opus via Claude Code CLI on EVO.

**Process:**
1. Opus reads the brief + actual source files named in the opportunity
2. Produces a detailed spec:

```json
{
  "title": "Smart follow-up skill",
  "goal": "After substantive answers, generate 2-3 contextual follow-up questions",
  "success_criteria": [
    "Skill triggers on legal/planning/general_knowledge responses > 200 chars",
    "Follow-up questions are relevant to the topic discussed",
    "Does not trigger on greetings, short answers, or group chats",
    "Tests cover 12+ cases (positive + negative)",
    "No eval regression"
  ],
  "steps": [
    "Create src/skills/__tests__/smart-follow-up.test.js with 12 test cases",
    "Run tests (should fail — TDD)",
    "Create src/skills/smart-follow-up.js implementing the skill contract",
    "Register in src/skill-registry.js",
    "Run tests again (should pass)",
    "Run full eval suite, verify no regression",
    "Smoke test with 10 real messages from today's logs"
  ],
  "files_new": ["src/skills/smart-follow-up.js", "src/skills/__tests__/smart-follow-up.test.js"],
  "files_modified": ["src/skill-registry.js"],
  "estimated_lines": 120,
  "auto_deploy_classification": {
    "verdict": "auto-deploy",
    "reasoning": "New skill files + registry update only. Additive. Cannot break existing flows."
  }
}
```

3. Spec saved to `data/forge/specs/YYYY-MM-DD-task-N.json`

**Auto-deploy classification rules (architect's initial call):**

Auto-deployable (all must be true):
- Max 3 files modified (new files in src/skills/ don't count toward limit)
- Max 80 lines changed in existing files
- No new dependencies
- Only touches src/, eval/, src/skills/
- Has measurable success criteria
- Risk assessment is "low"

Needs approval (any one triggers):
- Modifies message-handler.js, router, classifier, index.js, or any tool handler
- Changes system prompts or personality
- Touches soul system
- Risk assessment is "medium" or "high"
- No measurable success criteria

**Failure mode:** If Opus can't produce a valid spec, log it and move to meta-improvement task.

### Phase 3: Implement + Test

**Executor:** Opus via Claude Code CLI on EVO.

**Invocation:**

```bash
claude -p --model claude-opus-4-6 \
  --allowedTools "Edit,Write,Read,Bash,Glob,Grep" \
  < /tmp/forge-task.md
```

The prompt contains: spec, EVOLUTION.md, skill contract, 2-3 existing skill examples, eval baseline.

**TDD Flow:**

```
Step 1: Write test cases FIRST
  -> src/skills/__tests__/[skill-name].test.js
  -> canHandle() positive/negative cases
  -> execute() expected shape
  -> no interference with other skills

Step 2: Run tests (should fail)
  -> node --test src/skills/__tests__/[skill-name].test.js

Step 3: Implement the skill
  -> src/skills/[skill-name].js (skill contract)
  -> Register in src/skill-registry.js

Step 4: Run tests (should pass)
  -> If fail: fix and retry (up to 3 cycles)

Step 5: Full eval suite
  -> node eval/router-eval.js
  -> node eval/needsplan-eval.js
  -> If regression > 2%: revert and stop

Step 6: Integration smoke test
  -> Import skill, call canHandle() on 10 real messages from today's logs
  -> Verify triggers correctly, stays silent correctly
  -> Call execute() on triggered messages, verify output well-formed

Step 7: Commit to branch
  -> git checkout -b forge/[skill-name]
  -> git add + commit with structured message
```

**Fix cycle:** On test failure, Opus gets error output + source code + prompt: "Fix the implementation. Do not modify the test — the test defines correct behaviour." Max 3 cycles. After 3 failures: mark task failed, move on.

**Scope enforcement (unchanged from current system):**
- PreToolUse hook blocks writes outside allowed paths
- Allowed: src/, eval/, src/skills/, src/skills/__tests__/
- Banned: CLAUDE.md, .env, package.json, data/, auth_state/, etc.
- Post-validation: actual diff checked against spec's declared files

**New skill safety property:** Skills are sandboxed by construction. A new skill can ONLY create files in src/skills/ and src/skills/__tests__/, and ONLY modify src/skill-registry.js. It cannot reach into existing code. This makes auto-deploy safe for new skills.

### Phase 4: Review

**Executor:** Fresh Opus session (separate claude -p invocation, no shared context).

**Reviewer sees only:**
1. The original spec
2. The git diff
3. Test results
4. Eval scores before and after
5. The skill contract

**Does NOT see:** The coder's reasoning, struggles, or intermediate attempts.

**DGM-style evolutionary gate:** The reviewer doesn't just check "is this correct?" — it checks "is this an improvement over what exists?" If code is correct but doesn't actually improve anything: reject.

**Verdict:**

```json
{
  "verdict": "auto-deploy" | "needs-approval" | "reject",
  "confidence": 0.92,
  "checks": {
    "tests_pass": true,
    "eval_no_regression": true,
    "diff_within_bounds": true,
    "skill_contract_valid": true,
    "no_banned_files_touched": true,
    "no_side_effects": true,
    "code_quality": "good"
  },
  "override_architect": null,
  "summary": "New skill 'smart-follow-up' correctly triggers on substantive responses...",
  "concerns": [],
  "improvement_notes": "Next iteration could add category-specific templates"
}
```

**Auto-deploy decision (all must be true):**
- Reviewer verdict is "auto-deploy"
- All tests pass
- No eval regression > 2%
- Architect also classified as auto-deployable
- Diff within bounds

Any single failure -> needs-approval (queued for morning).

### Phase 5: Deploy or Queue

**Auto-deploy flow:**
1. Merge branch to main on EVO
2. rsync changed files to Pi
3. sudo systemctl restart clawdbot
4. Wait 5s, check service status
5. Run skill registry health check (all skills load, no import errors)
6. If health check fails: git revert, restart, mark "auto-deploy-failed", queue for review
7. If healthy: mark "deployed", update skill metrics

**Needs-approval flow:**
Branch stays on EVO. WhatsApp DM to James with: what was built, why, the diff, test results, reviewer summary. "Reply approve to deploy or reject to discard."

### Phase 6: Meta-Improvement (Tier 3)

After primary task completes, the Forge picks the top meta-opportunity and implements it. Same TDD flow but always auto-deployable (targets eval/ and data/forge/prompts/ only).

**What gets recursively improved:**

Architect prompts (`data/forge/prompts/architect.md`):
- Score own specs: first-try success vs needed fix cycles? Scope estimate accurate?
- Extract patterns from successful specs, anti-patterns from failures

Review criteria (`data/forge/prompts/reviewer.md`):
- Track which auto-deploys caused issues (detected via next-day traces)
- Track which needs-approval tasks James approved vs rejected
- Tighten where auto-deploys failed; loosen where James always approves

Intelligence gathering (`data/forge/prompts/analyst.md`):
- Track which opportunities led to impactful skills (high trigger + helpful)
- Track which led to dead skills (never triggered)
- Refine ranking algorithm

Test generation (`data/forge/prompts/tester.md`):
- Track which tests caught real regressions vs always-pass boilerplate
- Improve test generation for more meaningful coverage

### Phase 7: Report

The Forge generates a morning report:

```
*THE FORGE — Overnight Report*

*New Skill Deployed:* smart-follow-up
  After substantive answers, I now suggest 2-3 follow-up questions.
  Tests: 12/12 passing. Eval: no regression.
  Auto-deployed at 02:47.

*Awaiting Approval:* conversation-threading
  Reviewer flagged: modifies buildContext() — needs your sign-off.
  Reply 'approve' or 'reject'.

*Meta-Improvement:*
  Added 18 new needsPlan eval cases (was 24, now 42).
  Refined architect prompt based on last 3 nights' spec quality.

*Forge Health:*
  Tasks: 3 attempted | 1 deployed | 1 awaiting | 0 failed
  Eval: keyword 94.2->94.2 | needsPlan F1 78.5->83.1
  Session: 4h 12m | Fix cycles: 1/3

*Tomorrow's candidates:*
  1. Memory-grounded responses (high impact)
  2. Expand smart-follow-up to groups (enhancement)
```

## 5. Data Layout

```
data/forge/
  specs/              # Architect output per task
    2026-04-03-task-1.json
  reports/            # Nightly summary reports
    2026-04-03.json
  prompts/            # Recursively improved prompts
    architect.md
    reviewer.md
    analyst.md
    tester.md
  meta/               # Meta-improvement tracking
    spec-quality-log.jsonl    # Did specs lead to clean implementations?
    deploy-outcome-log.jsonl  # Did auto-deploys cause issues?
    skill-impact-log.jsonl    # Which skills triggered and helped?
  history.jsonl       # Append-only audit trail of all Forge actions

src/skills/           # Skill modules (auto-discovered)
  __tests__/          # Skill-specific tests
  smart-follow-up.js
  ...

src/skill-registry.js # Auto-discovery, query interface, self-knowledge
```

## 6. Orchestrator

`src/tasks/forge-orchestrator.js` — runs on Pi, replaces overnight-coder.py call.

Responsibilities:
- Assemble inputs for Phase 1 (read local data files)
- Call 30B on EVO for intelligence gathering
- SSH to EVO to run Opus via Claude Code CLI for phases 2-4
- Handle deploy/queue decision
- Run meta-improvement task
- Generate report
- Send WhatsApp summary
- Log everything to data/forge/

The orchestrator is human-maintained code. The Forge cannot modify its own orchestrator — that's the one hard boundary. Everything else (prompts, criteria, evals, skills) is within scope for recursive improvement.

## 7. Safety Properties

**Skill sandboxing:** New skills can only create files in src/skills/ and modify the registry. They cannot touch message-handler.js, router, classifier, or any existing flow. Bad skills are inert — they just don't trigger.

**Three-gate validation:** Architect classifies -> Tests must pass -> Reviewer validates. All three must agree for auto-deploy.

**Evolutionary gate (from DGM):** Changes must be improvements, not just correct. "Did the metric improve?" not "does it compile?"

**Auto-revert:** Failed deploys automatically revert within seconds.

**Rate limiting:** Max 3 tasks per day (unchanged). 1 hour cooldown between tasks.

**Banned scope:** CLAUDE.md, .env, package.json, data/ (except data/forge/prompts/ which is writable for meta-improvement), auth_state/, the orchestrator itself — all untouchable.

**Human override:** James can disable any skill, reject any pending change, or direct the Forge via WhatsApp.

## 8. Migration from Current System

**Replaced:**
- `evo-overnight/overnight-coder.py` (30B reflexion loops) -> Forge Phase 3 (Opus via Claude Code)
- `evo-evolve/run-evolution.sh` (single-fix overnight) -> Forge orchestrator
- `src/self-improve/cycle.js` (keyword rule learning) -> Forge meta-improvement + skill system
- `src/tasks/overnight-to-evolution.js` (bridge) -> Forge intelligence gathering
- `src/tasks/weekly-retrospective.js` (Sunday retro) -> Forge Phase 1 (runs every night)

**Kept unchanged:**
- Dream mode (22:05) — diary + memory extraction
- Model swap timers (22:00, 06:00)
- Evolution executor two-pass model (reused for non-skill tasks)
- Scope guard hooks
- Eval framework (expanded, not replaced)
- WhatsApp approval flow

**New:**
- `src/skills/` directory + skill contract
- `src/skill-registry.js`
- `src/tasks/forge-orchestrator.js`
- `data/forge/` directory structure
- Recursive meta-improvement prompts

## 9. Success Criteria

**Week 1:** Forge runs nightly, produces at least 1 skill or improvement per night. Some may be mediocre. Auto-deploy works for simple cases.

**Week 2:** Skills triggering in real conversations. James notices Clawd is more helpful. Meta-improvement starts refining the process.

**Week 4:** Measurable improvement in eval scores. Dead skills pruned. Forge prompts noticeably better than initial versions. Clawd can explain its own capabilities accurately.

**Month 2:** Compounding effect visible. Skills build on each other. The Forge consistently produces high-quality work with minimal morning review needed. James trusts auto-deploy for most changes.

## 10. What This Doesn't Do

- No changes during the day (overnight only)
- No A/B testing (traffic too low)
- No dependency changes (npm install is banned)
- No infrastructure modifications (model swaps, systemd units — human only)
- No personality/soul changes without James's approval
- The orchestrator itself cannot be modified by the Forge
