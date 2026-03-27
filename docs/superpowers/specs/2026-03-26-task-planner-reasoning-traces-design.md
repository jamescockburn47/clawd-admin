# Phase 1: Task Planner + Reasoning Traces

> Design spec for Clawdbot's first AGI-phase capability upgrade.
> Approved: 2026-03-26

## Objective

Add two capabilities that make Clawd measurably more useful and structurally enable future AGI phases:

1. **Reasoning traces** — persist the *why* behind every routing, engagement, and model selection decision
2. **Task planner** — decompose multi-step requests into ordered, dependency-aware plans with parallel execution

Every phase must ship value. No capability exists unless it makes Clawd better at its job.

## Part A: Reasoning Traces

### What

Every routing decision already flows through `router.js` and `engagement.js`. The gap is that the reasoning isn't persisted — when something goes wrong, there's no trail.

### Data Model

```js
// Appended to data/reasoning-traces.jsonl — one line per message processed
{
  timestamp: '2026-03-26T14:30:00.000Z',
  messageId: 'msg_abc123',
  chatId: 'group@g.us',
  sender: '447xxx@s.whatsapp.net',

  engagement: {
    decision: 'YES',           // YES | NO | BYPASS | MUTED | COOLDOWN
    reason: 'classifier',      // direct_mention | classifier | cooldown | muted | keyword_fallback
    confidence: 0.85,
    timeMs: 48
  },

  routing: {
    category: 'PLANNING',
    layer: 'classifier',       // keyword | classifier | fallback
    matched: null,             // keyword rule name if layer=keyword
    confidence: 0.91,
    needsPlan: true,
    planReason: 'multiple_verbs',  // multiple_verbs | conditional | temporal_deps | explicit_steps
    forceClaude: true,
    alternatives: ['GENERAL_KNOWLEDGE'],
    timeMs: 85
  },

  model: {
    selected: 'minimax',       // evo | minimax | claude
    reason: 'needsPlan',       // default | forceClaude | needsPlan | explicit_request | fallback
    qualityGate: true,         // whether Opus review triggered
    critiqueModel: 'claude-opus-4-6'
  },

  plan: null,                  // populated if needsPlan — see Part C

  totalTimeMs: 2340
}
```

### Implementation

- `router.js` returns a `trace` object alongside category — no new file needed
- `engagement.js` returns a `trace` object alongside decision
- `claude.js` assembles the full trace, appends to `data/reasoning-traces.jsonl`
- Traces are append-only. No rotation needed short-term (one line per processed message, ~500 bytes each). Overnight coder can add rotation later if volume warrants it.

### What traces enable

- Overnight coder analyses classifier accuracy: "4B said PLANNING but it was actually CALENDAR — tune the prompt"
- Dream mode reflects on decision quality in diary
- Evolution tasks auto-created from trace patterns: "classifier accuracy on RECALL is 68% — create task to add keyword rules"
- Manual debugging: `grep needsPlan data/reasoning-traces.jsonl | jq .`

## Part B: Classifier Upgrade (Qwen3-4B)

### Why

The 0.6B classifier works for binary engagement gating (YES/NO) but is too small for nuanced complexity routing. Research shows 4B models match 72B-class on classification tasks. Qwen3-4B-Instruct-2507 ranks #1 among 12 small models benchmarked (Distil Labs, 2025).

### Architecture

**Two-tier classification:**

| Tier | Model | Port | Role | When |
|------|-------|------|------|------|
| 1 | Qwen3-0.6B (existing) | 8081 | Binary engagement gate (respond/silent) | Every group message |
| 2 | Qwen3-4B-Instruct-2507 | 8085 | Category + complexity + needsPlan | After Tier 1 says YES |

The 4B replaces the 0.6B's current role in `router.js` for category classification. The 0.6B continues doing what it does well — fast binary gating.

### New systemd service on EVO

```
llama-server-planner.service — port 8085
Qwen3-4B-Instruct-2507 Q4_K_M (~2.5GB VRAM)
Flags: --flash-attn on --mlock --no-mmap --reasoning off
       --cont-batching --cache-type-k q8_0 --cache-type-v q8_0
Context: 8192 (classification doesn't need more)
```

Runs 24/7 alongside all other services. Total additional VRAM: ~2.5GB out of ~68GB free.

### 4B classifier prompt

The 4B receives the message + last 3 messages of context and outputs structured JSON:

```
You are a message classifier for a WhatsApp assistant called Clawd.

Classify this message into ONE category and determine if it needs multi-step planning.

Categories: CALENDAR, TASK, TRAVEL, EMAIL, RECALL, PLANNING, CONVERSATIONAL, GENERAL_KNOWLEDGE, SYSTEM

needsPlan is TRUE when the message requires 2+ distinct tool calls with ordering or dependencies:
- Multiple actions: "add a todo for Friday and check my calendar"
- Research + action: "look up what the group said about RAG hallucinations and summarise it for me"
- Conditional: "if I'm free Thursday, book the 0930 from Kings Cross"
- Sequential: "draft a reply to that email and then add a reminder to follow up Monday"

needsPlan is FALSE for:
- Single tool calls: "what's on my calendar tomorrow"
- Conversational: "what do you think about X"
- Information retrieval: "search for Y"

Output JSON only: {"category": "...", "needsPlan": true/false, "planReason": "multiple_actions|conditional|sequential|research_then_action|null", "confidence": 0.0-1.0}
```

### Overnight self-improvement integration

The self-improvement cycle (`src/self-improve/cycle.js`) runs overnight to measure classifier accuracy. It must be updated to:
- **Probe the 4B** on port 8085 for category + `needsPlan` classification accuracy (not the 0.6B, which only handles engagement gating)
- Generate synthetic multi-step messages to test `needsPlan` detection — covering legal, research, admin, and personal planning scenarios
- Add `needsPlan` boolean + `planReason` to the eval label set
- Continue probing the 0.6B separately for engagement gating only (YES/NO accuracy)

## Part C: Task Planner

### When it triggers

`needsPlan: true` from the 4B classifier. Expected frequency: ~5% of messages that reach classification.

### Example triggers (full range of assistant capabilities)

**Legal work:**

| Message | Plan steps |
|---------|-----------|
| "Search my emails for anything from counsel re the mining dispute and summarise the current position" | gmail_search → gmail_read (multiple) → synthesise position summary |
| "Check what the group discussed about disclosure strategy and draft me a note on it" | memory_search → synthesise into structured note |
| "Look up the latest on AI disclosure rules in litigation and compare with what we discussed last month" | web_search → memory_search → compare + synthesise |
| "Find the Harvey AI pricing page and compare it with what Legora quoted us" | web_search (Harvey) → web_search (Legora) → memory_search (quotes) → compare |

**Research & documents:**

| Message | Plan steps |
|---------|-----------|
| "Research current RAG hallucination mitigation techniques and summarise the top 3 approaches" | web_search (multiple queries) → synthesise ranked summary |
| "What's the latest on llama.cpp Vulkan performance for Strix Halo and has anything changed since we last looked" | web_search → memory_search (previous findings) → compare + synthesise |
| "Find out what SRA's position is on AI use in legal practice and add a todo to review it" | web_search → synthesise → todo_add |

**Personal admin:**

| Message | Plan steps |
|---------|-----------|
| "Add a todo for the disclosure deadline Friday and check if I have any meetings that day" | todo_add → calendar_list → report conflicts |
| "If I'm free Thursday afternoon, draft an email to Sarah about the mediation" | calendar_find_free_time → gmail_draft (conditional on result) |
| "Check my emails from Harcus Parker this week and add follow-up todos for anything urgent" | gmail_search → gmail_read (multiple) → todo_add (multiple) |
| "What's Henry's schedule this weekend and are there any trains from London to York on Saturday morning" | calendar_list → train_departures → synthesise travel plan |

**Memory & reflection:**

| Message | Plan steps |
|---------|-----------|
| "What did the group say about Harvey vs Legora, and has anything changed since?" | memory_search → web_search → compare + synthesise |
| "Look up what LQuorum discussed about RAG hallucinations and send me a summary" | memory_search → web_search (if memory insufficient) → synthesise |
| "What have I been working on this week? Check my calendar, emails, and todos" | calendar_list → gmail_search → todo_list → synthesise weekly summary |

### Plan lifecycle — kept in memory

Plans are stored in a `Map` keyed by plan ID. They persist in memory for the lifetime of the process (surviving across messages but not across restarts). This enables:

- **Diagnostics:** Query active/recent plans via `/api/plans` endpoint
- **Follow-up:** If the user asks about a previous plan's result, it's still in context
- **Trace correlation:** The reasoning trace references the plan by ID; the plan itself is queryable
- **Dream mode:** Overnight, dump completed plans to `data/reasoning-traces.jsonl` for reflection

Plans are also written to traces on completion. The in-memory store is the hot copy; traces are the cold archive.

**Pruning:** Plans older than 2 hours are pruned on a 10-minute interval. This keeps memory bounded without losing anything useful (most plans complete in seconds).

### Data model

```js
{
  id: 'plan_abc123',
  createdAt: '2026-03-26T14:30:00.000Z',
  completedAt: '2026-03-26T14:30:04.200Z',  // null while executing
  message: 'Check my emails from Harcus Parker and add follow-up todos',
  chatId: 'owner@s.whatsapp.net',
  sender: '447xxx@s.whatsapp.net',
  status: 'completed',  // planning | validating | executing | replanning | completed | failed | aborted

  steps: [
    {
      id: 1,
      description: 'Search emails from Harcus Parker this week',
      tool: 'gmail_search',
      toolInput: { query: 'from:harcusparker newer_than:7d' },
      dependsOn: [],
      status: 'completed',
      result: { emails: [...] },
      startedAt: '...',
      completedAt: '...',
      timeMs: 890,
      error: null
    },
    {
      id: 2,
      description: 'Read each email for urgency assessment',
      tool: 'gmail_read',
      toolInput: { messageId: '{{step1.result.emails[0].id}}' },
      dependsOn: [1],
      status: 'completed',
      result: { body: '...' },
      // ...
    },
    {
      id: 3,
      description: 'Add follow-up todo for urgent items',
      tool: 'todo_add',
      toolInput: { text: '{{derived from step 2}}', dueDate: '...' },
      dependsOn: [2],
      status: 'completed',
      // ...
    }
  ],

  replanCount: 0,
  failedSteps: [],

  decomposition: {
    model: 'evo-30b',  // local EVO 30B preferred, MiniMax fallback
    pass1TimeMs: 1200,
    pass2TimeMs: 800,
    validationResult: 'pass',  // pass | fail_tools | fail_deps | fail_params | fail_cycle
    validationErrors: []
  }
}
```

### Two-pass decomposition

Decomposition runs on the **EVO 30B-A3B** (port 8080) by default — free, fast (~72 tok/s, ~7s for a plan), and sufficient for structured JSON output. MiniMax M2.7 is the fallback if the 30B is unavailable (circuit breaker open). The 30B should run with `--parallel 2` to handle decomposition requests alongside regular queries without queueing.

**Pass 1 (sketch)** — EVO 30B (port 8080), MiniMax fallback:

```
You are a task planner for a personal and legal assistant called Clawd.
James is a senior commercial litigation solicitor. Clawd helps with legal research,
document preparation, case management, personal admin, and general knowledge.

Break this request into ordered steps. Each step calls exactly ONE tool.

Rules:
- Only add depends_on when a step genuinely needs another step's output
- Steps without dependencies CAN run in parallel — do not make things sequential unnecessarily
- Maximum 8 steps. If it needs more, say "This request is too complex for automated planning"
- Use only tools from the available list
- For research tasks, prefer memory_search first (check what Clawd already knows) before web_search
- For email tasks, search first, then read specific messages, then act on them

Available tools:
{scoped_tool_list_with_one_line_descriptions}

Request: "{message}"

Output a JSON array of steps only, no other text:
[{"step_id": 1, "description": "...", "tool": "tool_name", "tool_input": {...}, "depends_on": []}]
```

**Pass 2 (refine)** — Same model, given sketch + full tool schemas:

```
Refine this plan. For each step:
1. Verify tool_input matches the tool's parameter schema exactly
2. Check depends_on — only include dependencies where a step needs another's output value
3. Add expected_output: one sentence describing what this step should return
4. If a step depends on another, show which field from the dependency it uses

Tool schemas:
{relevant_tool_json_schemas}

Plan to refine:
{pass1_output}

Output refined JSON array only, no other text.
```

### Code-level validation (no LLM)

After Pass 2, before execution:

1. **Tool existence:** Every `tool` field matches a key in `definitions.js`
2. **Dependency validity:** All `depends_on` IDs reference real step IDs in the plan
3. **Acyclicity:** Topological sort succeeds (no circular dependencies)
4. **Step count:** ≤ 8
5. **Required params:** Each `tool_input` has required fields per the tool schema

If validation fails → log the malformed plan to traces with `validationResult` and `validationErrors`, fall back to single-shot existing behaviour. The plan object is still stored in memory for diagnostics.

### Template variable resolution

Steps that depend on earlier steps need access to their results. The planner's Pass 2 output uses placeholder references like `"messageId": "{{step1.result.emails[0].id}}"`. Before executing a step, the executor resolves these:

1. Parse `tool_input` for `{{stepN.result.path}}` patterns
2. Walk the referenced step's `result` object using the dot-path
3. Replace the placeholder with the actual value
4. If a reference can't be resolved (missing path, null result), the step fails with a clear error — triggering local repair

This is simple string-template resolution, not an expression language. Array indexing (`[0]`) and dot-paths are supported. No arbitrary JS eval.

### Execution

1. Topological sort determines execution order
2. Independent steps (no shared dependencies) run in parallel via `Promise.all`
3. Before each step, resolve template variables from completed dependency results
4. Per-step timeout from `constants.js` (default 30s per step, 120s total plan)
5. Each step result updates the in-memory plan object in real-time

### Failure recovery (three-tier)

1. **Local repair:** Retry the failed step once with the error message as additional context to the decomposition model (EVO 30B or MiniMax fallback): "This tool call failed with error X. Adjust the parameters and try again." If it succeeds, continue the plan.

2. **Suffix replan:** If local repair fails, send the partial plan state (completed steps + failed step + error) to the decomposition model: "Steps 1-2 completed successfully with these results. Step 3 failed because X. Replan the remaining steps to achieve the original goal given what we have so far." Validate and execute the new suffix.

3. **Abort:** If suffix replan also fails or produces an invalid plan, stop. Report what completed and what couldn't be done. For a WhatsApp bot, a partial answer in 5 seconds beats a perfect answer in 30 seconds.

`replanCount` tracks attempts. Maximum 1 suffix replan. No full replans — they're too expensive for the marginal improvement.

### Response synthesis

After all steps complete (or abort), one final call to the decomposition model (EVO 30B, MiniMax fallback):

```
Given these completed steps and their results, write a natural WhatsApp response.
Do NOT list steps or say "Step 1 did X". Synthesise into a coherent answer
as if you did the work yourself. Be concise and direct — this is WhatsApp, not an essay.
No emojis. No filler. If something failed, say what you couldn't do and why.

Completed steps:
{step_results_summary}

Original request: "{message}"
```

The synthesis response flows through the existing quality gate (Opus review for PLANNING/LEGAL categories) and then the normal WhatsApp send pipeline.

### API endpoint for diagnostics

New endpoint: `GET /api/plans`

Returns recent plans from the in-memory store (last 2 hours). Useful for debugging from the dashboard or via curl. No auth change needed — same Bearer token as other API endpoints.

## Part D: Overnight Integration

### Dream mode

`dream_mode.py` already processes the day's interactions. With traces and plans available in `data/reasoning-traces.jsonl`, the dream prompt gains new reflection material:

- "Today I planned 3 multi-step requests. Plan plan_abc123 failed at step 3 (gmail_search returned empty) — I should have checked if the date range was right before searching."
- "The 4B classifier marked 'what did the group think about Harvey' as GENERAL_KNOWLEDGE but it should have been RECALL — I need to improve recognition of group memory queries."

No code change in dream_mode.py needed — it already reads interaction logs. The traces are richer data in the same pipeline.

### Overnight coder — classifier probing

`src/self-improve/cycle.js` changes:

- **New probe target:** Port 8085 (4B) for category + needsPlan classification
- **New test cases:** Synthetic multi-step messages testing needsPlan accuracy
- **Dual evaluation:** Probe 0.6B for engagement accuracy, probe 4B for routing accuracy
- **Eval suite expansion:** Add `needsPlan` boolean + `planReason` to eval labels

### Evolution task generation from traces

A new scheduled task (daily, after overnight extraction) analyses traces:

- Classifier accuracy below threshold on any category → create evolution task to tune classifier prompt
- Plan validation failure rate above threshold → create evolution task to improve planning prompt
- Specific tool failures recurring → create evolution task to add error handling

This is Phase 2 work (autonomous goal generation) but the trace data from Phase 1 is the prerequisite.

## Part E: Hardware Optimisation

Research conducted 2026-03-26. Hardware: GMKTec NucBox EVO X2, 128GB unified memory.

### Current state

| Resource | Used | Free | Notes |
|----------|------|------|-------|
| VRAM (unified) | ~24GB | ~72GB | Massive headroom |
| Memory bandwidth | ~157 GB/s peak concurrent | ~215 GB/s measured | 84% of 256 GB/s theoretical |
| GPU compute | Light (MoE = only 3B active params) | Abundant | RDNA 3.5, Vulkan RADV backend |
| NPU (XDNA 2) | 0% | 100% | No usable inference stack on Linux |

### Decision: Decomposition runs locally on EVO 30B

The research shows the existing 30B-A3B generates at ~72 tok/s on this hardware. A structured JSON plan (~500 tokens) completes in ~7 seconds. This is comparable to MiniMax cloud roundtrip and it's free.

**Requirement:** The 30B's llama-server must run with `--parallel 2` to handle decomposition requests alongside regular queries without queueing. With the MoE architecture (3B active params), two concurrent slots use ~244 GB/s peak bandwidth — within the 215 GB/s envelope with manageable contention.

MiniMax remains as fallback only (circuit breaker on the 30B).

### Confirmed: 4B is right for classification

Benchmarks confirm Qwen3-4B tops classification and structured output at its size:
- 90.96% on JSON generation (StructEval)
- #1 among 12 small models on classification tasks (Distil Labs)
- 8B gives diminishing returns at double the VRAM cost

### NPU: Dead end

llama.cpp has no XDNA/NPU backend. The feature request was closed August 2025 due to inactivity. No usable inference path on Linux. Ignore until 2027+.

### System-level tweaks to apply

If not already done:
- `amd_iommu=off` kernel parameter → ~6% more memory bandwidth
- `tuned` with `accelerator-performance` profile → ~3% additional
- Verify Vulkan RADV is the active backend (not ROCm — regression in ROCm 7.0.1)

### Model upgrade to watch

Qwen3.5-35B-A3B — same 3B active params, better benchmarks (IFEval 91.9, BFCL-V4 67.3, MMLU-Pro 85.3). Drop-in replacement for the current 30B. Gated DeltaNet hybrid architecture with 256 experts. Monitor for stable GGUF release.

## Files Changed

| File | Change | Lines est. |
|------|--------|-----------|
| `src/task-planner.js` | **NEW** — decompose, validate, execute, replan, synthesise, in-memory store, pruning | ~250 |
| `src/reasoning-trace.js` | **NEW** — trace assembly + JSONL persistence | ~30 |
| `src/router.js` | Add trace returns, route category classification to 4B (port 8085), emit needsPlan | ~30 changed |
| `src/engagement.js` | Add trace returns | ~15 changed |
| `src/claude.js` | Assemble + log traces, route needsPlan to task-planner | ~40 changed |
| `src/evo-client.js` | Add planner circuit breaker + health check (port 8085) | ~10 changed |
| `src/evo-llm.js` | Add `classifyVia4B()` function for 4B classifier | ~40 added |
| `src/constants.js` | Planning constants (timeouts, max steps, replan limit, prune interval) | ~15 added |
| `src/config.js` | `EVO_PLANNER_URL` env var (default `http://10.0.0.2:8085`) | ~5 added |
| `src/http-server.js` | Add `/api/plans` endpoint | ~15 added |
| `docs/evo-x2-reference.md` | Add planner service to table | ~5 changed |
| `docs/data-flows.md` | Update message flow to include planner branch | ~15 changed |
| `docs/api-reference.md` | Add `/api/plans` endpoint | ~3 added |

**EVO infrastructure:**
- Download Qwen3-4B-Instruct-2507 Q4_K_M GGUF
- Create `llama-server-planner.service` systemd unit (port 8085)
- Enable and start the service
- Update llama-server main (port 8080) to `--parallel 2`
- Apply system-level tweaks if not already done

## Constants

```js
// In src/constants.js
PLAN_MAX_STEPS: 8,
PLAN_STEP_TIMEOUT_MS: 30_000,
PLAN_TOTAL_TIMEOUT_MS: 120_000,
PLAN_MAX_REPLANS: 1,
PLAN_PRUNE_INTERVAL_MS: 600_000,  // 10 minutes
PLAN_PRUNE_AGE_MS: 7_200_000,     // 2 hours
PLAN_MIN_CONFIDENCE: 0.7,         // below this, fall back to single-shot
```

## Out of Scope (Future Phases)

- **Dashboard plan visualisation** — Phase 2, after the data model is proven
- **Autonomous goal generation from traces** — Phase 2, depends on trace volume
- **Predictive scheduler** — Phase 3, depends on pattern recognition from traces
- **Inference-time critique/debate** — Phase 3, independent of planning
- **Plan templates** — if certain plan patterns recur, cache them. Not yet.
