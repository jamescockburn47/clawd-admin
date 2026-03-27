# Phase 1 Implementation Plan: Task Planner + Reasoning Traces

> Design spec: `docs/superpowers/specs/2026-03-26-task-planner-reasoning-traces-design.md`
> AGI roadmap: `PLAN-agi-roadmap.md`

## Prerequisites

- [ ] Download Qwen3-4B-Instruct-2507 GGUF to EVO
- [ ] Create and start `llama-server-planner.service` on EVO (port 8085)
- [ ] Verify 4B responds correctly via curl

## Step 1: Infrastructure — Constants + Config + EVO Client

**Files:** `src/constants.js`, `src/config.js`, `src/evo-client.js`

### constants.js — Add planning constants

After the existing `COOLDOWNS` block, add a new frozen object:

```js
export const PLANNING = Object.freeze({
  MAX_STEPS: 8,
  STEP_TIMEOUT_MS: 30_000,
  TOTAL_TIMEOUT_MS: 120_000,
  MAX_REPLANS: 1,
  PRUNE_INTERVAL_MS: 600_000,     // 10 min
  PRUNE_AGE_MS: 7_200_000,        // 2 hours
  MIN_CONFIDENCE: 0.7,            // below this, fall back to single-shot
  DECOMPOSE_TIMEOUT_MS: 15_000,   // per decomposition pass
  SYNTHESIS_TIMEOUT_MS: 10_000,   // final response synthesis
});
```

### config.js — Add planner URL

After `evoClassifierUrl` (line 57):

```js
evoPlannerUrl: process.env.EVO_PLANNER_URL || 'http://10.0.0.2:8085',
```

After `evoClassifierLabel` (line 53):

```js
evoPlannerLabel: process.env.EVO_PLANNER_LABEL || 'llama-server :8085 (EVO X2, 4B planner)',
```

### evo-client.js — Add planner circuit breaker + health check

Add alongside existing breakers:

```js
export const plannerBreaker = new CircuitBreaker('evo-planner', { threshold: 3, resetTimeout: 60000 });

export async function checkPlannerHealth() {
  try {
    const res = await evoFetch(`${config.evoPlannerUrl}/health`, { timeout: TIMEOUTS.EVO_HEALTH_CHECK });
    const data = await res.json();
    return data.status === 'ok' || data.status === 'no slot available';
  } catch { return false; }
}
```

**Verification:** Unit test — import new constants, confirm frozen. Curl EVO planner health endpoint.

---

## Step 2: Reasoning Traces — Trace Logger

**Files:** NEW `src/reasoning-trace.js`

Single-responsibility file: assemble + persist reasoning traces.

```js
// src/reasoning-trace.js — Structured reasoning trace logger
import { appendFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const TRACE_FILE = join('data', 'reasoning-traces.jsonl');

/**
 * Log a complete reasoning trace for one message processing cycle.
 * Called from claude.js after the response is generated.
 */
export function logReasoningTrace(trace) {
  const entry = {
    timestamp: new Date().toISOString(),
    ...trace,
  };
  try {
    appendFileSync(TRACE_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.warn({ err: err.message }, 'reasoning trace write failed');
  }
}
```

**Shape of `trace` object** (assembled in claude.js):

```js
{
  messageId,        // WhatsApp message ID (if available)
  chatId,           // group JID or DM JID
  sender,           // sender JID

  engagement: {     // null for DMs (no engagement check)
    decision,       // 'YES' | 'NO' | 'BYPASS' | 'MUTED' | 'COOLDOWN'
    reason,         // 'classifier' | 'direct_mention' | 'cooldown' | 'muted' | 'keyword_fallback'
    confidence,     // float or null
    timeMs,
  },

  routing: {
    category,       // CATEGORY value
    layer,          // 'keyword' | 'complexity' | 'llm_classifier' | 'fallback' | 'image'
    needsPlan,      // boolean
    planReason,     // 'multiple_verbs' | 'conditional' | 'sequential' | 'research_then_action' | null
    forceClaude,
    writeIntent,    // boolean
    confidence,     // float or null
    timeMs,
  },

  model: {
    selected,       // 'evo' | 'minimax' | 'claude'
    reason,         // 'default' | 'forceClaude' | 'needsPlan' | 'explicit_request' | 'evo_fallback'
    qualityGate,    // boolean
  },

  plan: null,       // populated by task-planner if needsPlan

  toolsCalled: [],  // array of tool names
  totalTimeMs,
}
```

**Verification:** Process a test message, check `data/reasoning-traces.jsonl` has one line with correct structure.

---

## Step 3: Router Upgrade — 4B Classifier + needsPlan

**Files:** `src/router.js`, `src/evo-llm.js`

### evo-llm.js — Add 4B classifier function

New export alongside `classifyViaEvo`:

```js
/**
 * Classify via 4B model (port 8085) — category + needsPlan.
 * Returns { category, needsPlan, planReason, confidence } or null.
 */
export async function classifyVia4B(text, recentMessages = []) {
  // POST to config.evoPlannerUrl/v1/chat/completions
  // System prompt: PLANNER_CLASSIFY_PROMPT (see below)
  // User: recent context + message
  // Parse JSON response
  // Validate category is in VALID_CATEGORIES, needsPlan is boolean
  // Return structured result or null on parse failure
}
```

**PLANNER_CLASSIFY_PROMPT** (stored in evo-llm.js):

```
You are a message classifier for a WhatsApp assistant called Clawd.

Classify this message into ONE category and determine if it needs multi-step planning.

Categories: calendar, task, travel, email, recall, planning, conversational, general_knowledge, system

- "calendar" = checking schedule, creating/updating events, what's on, free time
- "task" = todos, reminders, task lists
- "travel" = trains, hotels, flights, fares, accommodation
- "email" = reading/sending/drafting emails, inbox
- "recall" = asking about something previously discussed, stored facts, memories
- "planning" = complex multi-step reasoning, organising
- "conversational" = chat, banter, greetings, opinions
- "general_knowledge" = factual questions, current info, web lookups
- "system" = questions about the bot itself, architecture, status

needsPlan is TRUE when the message requires 2+ distinct actions with ordering or dependencies:
- Multiple actions: "add a todo for Friday and check my calendar"
- Research + action: "look up what the group said about RAG and summarise it"
- Conditional: "if I'm free Thursday, book the 0930 from Kings Cross"
- Sequential: "draft a reply to that email and then add a reminder to follow up Monday"

needsPlan is FALSE for:
- Single tool calls: "what's on my calendar tomorrow"
- Conversational: "what do you think about X"
- Information retrieval: "search for Y"
- Simple questions: "who is X"

Output JSON only, no other text:
{"category": "...", "needsPlan": true/false, "planReason": "multiple_actions|conditional|sequential|research_then_action|null", "confidence": 0.0-1.0}
```

### router.js — Integrate 4B for category classification

**Current flow:** keywords → complexity → 0.6B LLM → fallback

**New flow:** keywords → 4B classifier (category + needsPlan) → complexity fallback → fallback

Replace the LLM classifier call (lines 378-392) with the 4B:

```js
// Layer 2: 4B classifier (category + needsPlan)
const classResult = await classifyVia4B(text, []); // recent messages later
if (classResult && VALID_CATEGORIES.has(classResult.category)) {
  const writeIntent = detectsWriteIntent(text);
  const forceClaude = CLAUDE_CATEGORIES.has(classResult.category)
    || WRITE_LIKELY_CATEGORIES.has(classResult.category)
    || writeIntent
    || classResult.needsPlan; // planning always uses Claude

  return {
    category: classResult.category,
    source: 'llm_classifier',
    forceClaude,
    reason: writeIntent ? 'write intent detected' : (forceClaude ? 'claude-only category' : null),
    needsPlan: classResult.needsPlan || false,
    planReason: classResult.planReason || null,
    confidence: classResult.confidence || null,
  };
}
```

**Also update the return type** for keywords and complexity layers — add `needsPlan: false, planReason: null, confidence: null` to those returns.

**Keep 0.6B** for engagement gating only (engagement.js unchanged).

**Verification:** Send test messages via WhatsApp:
- "what's on my calendar" → category: calendar, needsPlan: false
- "check my calendar and add a todo for the disclosure deadline" → needsPlan: true, planReason: multiple_actions
- "if I'm free Thursday, draft an email to Sarah" → needsPlan: true, planReason: conditional

---

## Step 4: Trace Integration in claude.js

**Files:** `src/claude.js`

### Changes

1. Import `logReasoningTrace` from `./reasoning-trace.js`
2. At the start of `getClawdResponse`, capture `startTime = Date.now()`
3. After routing (line 81), capture the route result including new `needsPlan` fields
4. After the response is generated (before return), assemble and log the trace:

```js
// Before every return point in getClawdResponse:
logReasoningTrace({
  chatId: chatJid,
  sender: senderJid,
  engagement: null, // populated by caller if group message
  routing: {
    category,
    layer: classifySource,
    needsPlan: route.needsPlan || false,
    planReason: route.planReason || null,
    forceClaude,
    writeIntent: !!routeReason?.includes('write'),
    confidence: route.confidence || null,
    timeMs: Date.now() - routeStart,
  },
  model: {
    selected: useClaudeClient ? 'claude' : (minimaxClient ? 'minimax' : 'claude'),
    reason: userWantsClaude ? 'explicit_request' : (forceClaude ? 'forceClaude' : 'default'),
    qualityGate: shouldCritique(category, text, useClaudeClient),
  },
  plan: null, // populated by task-planner
  toolsCalled: _lastToolsCalled,
  totalTimeMs: Date.now() - startTime,
});
```

This replaces the existing `logRouting()` calls (lines 191-194, 200-204, 208-212, 335-341) with the richer trace format. Keep `logRouting()` as well for backward compat with dashboard stats.

**Verification:** Process several messages, verify traces appear in `data/reasoning-traces.jsonl` with correct structure.

---

## Step 5: Task Planner — Core

**Files:** NEW `src/task-planner.js`

This is the largest new file (~250 lines). Single responsibility: decompose, validate, execute, replan, synthesise.

### Exports

```js
export async function executePlan(message, route, senderJid, chatJid, memoryFragment)
// Returns: { response: string, plan: object } or null on failure

export function getRecentPlans(limit = 20)
// Returns: array of recent plan objects from in-memory store

export function getPlanById(planId)
// Returns: plan object or null
```

### Internal structure

```
planStore (Map)           — in-memory plan storage, keyed by plan ID
startPruneTimer()         — 10-min interval, removes plans > 2 hours old

decompose(message, tools) — two-pass EVO 30B decomposition (MiniMax fallback)
  pass1(message, tools)   — sketch: message → step array
  pass2(sketch, tools)    — refine: validate params, add expected outputs

validatePlan(plan, tools) — code-level validation (no LLM)
  checkToolExists()
  checkDependencies()
  checkAcyclicity()
  checkStepCount()
  checkRequiredParams()

executePlan(plan)         — topological sort → parallel execution
  resolveTemplates(step)  — {{stepN.result.path}} → actual values
  executeStep(step)       — single tool call with timeout

repairStep(step, error)   — local repair: retry with error context
suffixReplan(plan, failed) — replan remaining steps after failure

synthesise(plan, message) — compile results into natural response
```

### Decomposition prompts

**Pass 1 (sketch)** — EVO 30B (port 8080) via `evo-llm.js`, MiniMax fallback:

```
You are a task planner for a personal and legal assistant called Clawd.
James is a senior commercial litigation solicitor. Clawd helps with legal research,
document preparation, case management, personal admin, and general knowledge.

Break this request into ordered steps. Each step calls exactly ONE tool.

Rules:
- Each step has: step_id, description, tool, tool_input, depends_on
- Only add depends_on when a step genuinely needs another step's output
- Steps without dependencies CAN run in parallel
- Maximum 8 steps
- Use only tools from the available list
- For research tasks, prefer memory_search first before web_search
- For email tasks, search first, then read specific messages, then act

Available tools:
{tool_name}: {description} (one line each)

Request: "{message}"

Output a JSON array of steps only, no other text:
[{"step_id": 1, "description": "...", "tool": "tool_name", "tool_input": {...}, "depends_on": []}]
```

**Pass 2 (refine)** — same model:

```
Refine this plan. For each step:
1. Verify tool_input matches the tool's parameter schema
2. Check depends_on — only include where a step needs another's output value
3. If a step depends on another, use {{stepN.result.field}} placeholders in tool_input
4. Add expected_output: one sentence describing what this step should return

Tool schemas:
{relevant_tool_json_schemas}

Plan to refine:
{pass1_output}

Output refined JSON array only, no other text.
```

**Fallback logic:** If EVO 30B circuit breaker is open, fall back to MiniMax M2.7 for decomposition. Both use the same prompts.

### Template resolution

```js
function resolveTemplates(toolInput, completedSteps) {
  const str = JSON.stringify(toolInput);
  const resolved = str.replace(/\{\{step(\d+)\.result\.([^}]+)\}\}/g, (match, stepId, path) => {
    const step = completedSteps.get(parseInt(stepId));
    if (!step?.result) return match; // unresolved — will fail validation
    return walkPath(step.result, path) ?? match;
  });
  return JSON.parse(resolved);
}

function walkPath(obj, path) {
  // Supports: "field", "field.subfield", "field[0]", "field[0].subfield"
  const parts = path.match(/[^.\[\]]+|\[\d+\]/g);
  let current = obj;
  for (const part of parts) {
    if (current == null) return null;
    const idx = part.match(/^\[(\d+)\]$/);
    current = idx ? current[parseInt(idx[1])] : current[part];
  }
  return current;
}
```

### Execution flow

```js
export async function executePlan(message, route, senderJid, chatJid, memoryFragment) {
  const plan = createPlan(message, chatJid, senderJid);
  planStore.set(plan.id, plan);

  // 1. Decompose
  plan.status = 'planning';
  const tools = getAvailableToolSchemas(senderJid);
  const steps = await decompose(message, tools);
  if (!steps) {
    plan.status = 'failed';
    plan.failureReason = 'decomposition_failed';
    return null; // caller falls back to single-shot
  }
  plan.steps = steps;

  // 2. Validate
  plan.status = 'validating';
  const validation = validatePlan(plan, tools);
  if (!validation.valid) {
    plan.status = 'failed';
    plan.failureReason = 'validation_failed';
    plan.validationErrors = validation.errors;
    return null;
  }

  // 3. Execute
  plan.status = 'executing';
  const completedSteps = new Map();
  const sortedSteps = topologicalSort(plan.steps);

  // Group by dependency level for parallel execution
  const levels = groupByLevel(sortedSteps);
  for (const level of levels) {
    const results = await Promise.all(
      level.map(step => executeStepWithRecovery(step, completedSteps, senderJid, chatJid))
    );
    // Check for failures
    for (const { step, success } of results) {
      if (!success && plan.replanCount < PLANNING.MAX_REPLANS) {
        // Suffix replan
        plan.status = 'replanning';
        plan.replanCount++;
        const remaining = getRemainingSteps(plan, step);
        const newSteps = await suffixReplan(plan, step, completedSteps);
        if (newSteps) {
          // Replace remaining steps and continue
          replaceRemainingSteps(plan, step, newSteps);
        } else {
          plan.status = 'failed';
          break;
        }
      }
    }
  }

  // 4. Synthesise
  if (plan.steps.some(s => s.status === 'completed')) {
    plan.status = 'completed';
    const response = await synthesise(plan, message);
    plan.completedAt = new Date().toISOString();
    return { response, plan };
  }

  plan.status = 'failed';
  return null;
}
```

### Integration point in claude.js

After routing, before the EVO/Claude call (around line 183):

```js
// Task planner — multi-step requests
if (route.needsPlan && route.confidence >= PLANNING.MIN_CONFIDENCE) {
  try {
    const planResult = await executePlan(context, route, senderJid, chatJid, memoryFragment);
    if (planResult) {
      // Log trace with plan data
      logReasoningTrace({ ...trace, plan: planResult.plan });
      return planResult.response;
    }
    // Plan failed — fall through to single-shot
    logger.warn('task planner failed, falling back to single-shot');
  } catch (err) {
    logger.error({ err: err.message }, 'task planner error');
  }
}
```

**Verification:** Send "check my calendar for Friday and add a todo for the disclosure deadline":
- Verify 4B classifies as needsPlan: true
- Verify decomposition produces 2 steps (calendar_list + todo_add)
- Verify both execute successfully
- Verify synthesised response reads naturally
- Verify plan appears in `data/reasoning-traces.jsonl`
- Verify `GET /api/plans` returns the plan

---

## Step 6: HTTP Endpoint for Plan Diagnostics

**Files:** `src/http-server.js`

Add after existing endpoints:

```js
// Task planner diagnostics
app.get('/api/plans', (req, res) => {
  if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
  const { getRecentPlans } = await import('./task-planner.js');
  const plans = getRecentPlans(20);
  json(res, 200, { plans, count: plans.length });
});

app.get('/api/plans/:id', (req, res) => {
  if (!checkAuth(req)) return json(res, 401, { error: 'unauthorized' });
  const { getPlanById } = await import('./task-planner.js');
  const plan = getPlanById(req.params.id);
  if (!plan) return json(res, 404, { error: 'plan not found' });
  json(res, 200, { plan });
});
```

**Verification:** After processing a planned message, `curl /api/plans` returns the plan with all steps.

---

## Step 7: Overnight Coder Integration

**Files:** `src/self-improve/cycle.js`

### Changes

1. Add probing for the 4B classifier on port 8085
2. Generate synthetic multi-step test messages for `needsPlan` accuracy
3. Dual evaluation: 0.6B for engagement, 4B for category + needsPlan

### New test cases for needsPlan

```js
const NEEDSPLAN_TESTS = [
  // TRUE — legal research + action
  { text: 'search my emails for anything from counsel re the mining dispute and summarise the current position', expected: true },
  { text: 'look up the SRA position on AI in legal practice and add a todo to review it', expected: true },
  { text: 'find what the group discussed about disclosure strategy and draft me a note on it', expected: true },

  // TRUE — personal admin combos
  { text: 'check my calendar and add a todo for the deadline', expected: true },
  { text: 'if I am free Thursday book the 0930 from Kings Cross', expected: true },
  { text: 'search my emails from HP and add todos for urgent ones', expected: true },
  { text: 'draft a reply to that email then remind me to follow up', expected: true },

  // TRUE — research + synthesis
  { text: 'look up what the group discussed about RAG and summarise', expected: true },
  { text: 'what have I been working on this week check calendar emails and todos', expected: true },
  { text: 'compare Harvey AI pricing with what Legora quoted us', expected: true },

  // FALSE — single tool calls
  { text: 'what is on my calendar tomorrow', expected: false },
  { text: 'add a todo for Friday', expected: false },
  { text: 'search the web for Harvey AI', expected: false },
  { text: 'search my emails for the disclosure letter', expected: false },

  // FALSE — conversational / knowledge
  { text: 'what do you think about the new model', expected: false },
  { text: 'who is the CEO of Anthropic', expected: false },
  { text: 'what is the limitation period for breach of contract', expected: false },
  { text: 'how are you feeling today', expected: false },
];
```

### Self-improvement loop addition

After existing keyword probing, add a needsPlan probing phase:
- Send each test case to port 8085
- Parse JSON response
- Compare `needsPlan` against expected
- Log accuracy to `data/self-improve-log.jsonl`
- If accuracy < 0.8, generate a diagnostic report (but don't auto-tune — 4B prompt tuning is manual for now)

**Verification:** Run self-improve cycle manually, check log shows needsPlan accuracy metrics.

---

## Step 8: EVO Infrastructure Setup

**On EVO X2 (SSH as james):**

### Download model

```bash
# Qwen3-4B-Instruct-2507 Q4_K_M — ~2.5GB
huggingface-cli download Qwen/Qwen3-4B-Instruct-2507-GGUF \
  qwen3-4b-instruct-2507-q4_k_m.gguf \
  --local-dir ~/models/
```

### Create systemd service

`/etc/systemd/system/llama-server-planner.service`:

```ini
[Unit]
Description=llama-server planner (Qwen3-4B, port 8085)
After=network.target gpu-clock-pin.service

[Service]
Type=simple
User=james
ExecStart=/home/james/llama.cpp/build/bin/llama-server \
  -m /home/james/models/qwen3-4b-instruct-2507-q4_k_m.gguf \
  --port 8085 \
  --host 0.0.0.0 \
  -ngl 99 \
  --flash-attn \
  --mlock \
  --no-mmap \
  -c 8192 \
  --cont-batching \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --reasoning off
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable llama-server-planner
sudo systemctl start llama-server-planner
curl http://localhost:8085/health  # verify
```

### Update main llama-server to --parallel 2

The 30B on port 8080 needs to handle decomposition requests alongside regular queries.
Update `/etc/systemd/system/llama-server.service` to add `--parallel 2`, then restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart llama-server
```

This halves per-request generation speed (~36 tok/s each) when both slots are active,
but allows decomposition and regular queries to run concurrently instead of queueing.

### System-level tweaks (if not already applied)

```bash
# Check current IOMMU status
cat /proc/cmdline | grep iommu
# If not already disabled, add amd_iommu=off to GRUB_CMDLINE_LINUX in /etc/default/grub
# Then: sudo update-grub && sudo reboot

# Install and enable tuned for performance profile
sudo apt install tuned
sudo tuned-adm profile accelerator-performance

# Verify Vulkan RADV backend (not ROCm)
vulkaninfo | grep driverName  # should show "radv"
```

### Update EVO X2 reference docs

Add to `docs/evo-x2-reference.md` service table:
- Port 8085: Qwen3-4B-Instruct-2507 Q4_K_M, 8K context, planner/classifier, always on
- Port 8080: Updated to `--parallel 2` for concurrent decomposition + regular queries

### Model upgrade note

Watch for Qwen3.5-35B-A3B stable GGUF release — same 3B active params as current 30B but
better benchmarks across the board (IFEval 91.9, BFCL-V4 67.3). Drop-in replacement.

---

## Execution Order

| Order | Step | Depends on | Effort |
|-------|------|-----------|--------|
| 1 | Step 8: EVO infrastructure | Nothing | 15 min |
| 2 | Step 1: Constants + config + evo-client | Step 8 | 10 min |
| 3 | Step 2: Reasoning trace logger | Nothing | 10 min |
| 4 | Step 3: Router + 4B classifier | Steps 1, 8 | 30 min |
| 5 | Step 4: Trace integration in claude.js | Steps 2, 3 | 20 min |
| 6 | Step 5: Task planner core | Steps 1, 3, 4 | 60 min |
| 7 | Step 6: HTTP endpoints | Step 5 | 10 min |
| 8 | Step 7: Overnight coder integration | Steps 3, 5 | 20 min |

**Total estimated: ~3 hours implementation + testing**

## Verification Checklist

- [ ] 4B model running on EVO port 8085
- [ ] Health check passes from Pi
- [ ] Single-tool messages route normally (no regression)
- [ ] Multi-step messages trigger needsPlan: true
- [ ] Decomposition produces valid JSON plans
- [ ] Plans execute with parallel independent steps
- [ ] Template variables resolve correctly
- [ ] Failed steps trigger local repair
- [ ] Synthesised responses read naturally (not step-by-step)
- [ ] Traces appear in reasoning-traces.jsonl
- [ ] /api/plans returns recent plans
- [ ] Overnight coder probes 4B classifier
- [ ] No regression in existing single-shot behaviour
- [ ] No regression in group engagement gating
