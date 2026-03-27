# Clawdbot AGI Roadmap

> Systematic progression toward AGI-like cognitive architecture.
> Started: 2026-03-26. Maintained across sessions.

## Scoring Baseline (2026-03-26)

ChatGPT's "minimum viable AGI-like stack" has 10 pillars. Clawd's current state:

| # | Pillar | Score | Status | Notes |
|---|--------|-------|--------|-------|
| 1 | Multi-model orchestration | 9/10 | STRONG | Three-tier (EVO free -> MiniMax cheap -> Claude premium), dynamic routing, circuit breakers, cost-aware selection. Missing: inference-time model comparison. |
| 2 | Memory system | 8/10 | STRONG | Working memory (LQuorum, 18 topics, 15-min decay), episodic (interaction logs, JSONL), semantic (EVO memory service, embeddings, dream consolidation). Missing: explicit memory consolidation scoring. |
| 3 | Tool use | 9/10 | STRONG | 58 tools, audit logging, owner gating, read/write safety classification. Missing: tool selection planning for multi-step. |
| 4 | Planning & reasoning | 7/10 | GOOD | Task decomposition (two-pass via 30B), dependency-aware parallel execution, adaptive replanning, failure recovery. Missing: inference-time critique, long-horizon plans. |
| 5 | Multi-agent system | 6/10 | PARTIAL | Engagement classifier + router + quality gate + task planner as distinct agents. Missing: deliberate agent negotiation, shared working memory between agents. |
| 6 | Control layer | 8/10 | GOOD | Router + engagement + quality gate + circuit breakers + cost tracking + reasoning traces (JSONL). Trace analysis overnight, anomaly detection. Missing: real-time cognitive dashboard. |
| 7 | Self-improvement | 8/10 | STRONG | Overnight keyword improvement (multi-iteration), dream mode memory consolidation, evolution pipeline (self-coding via Claude Code CLI), learned rules graduation. Missing: autonomous goal generation. |
| 8 | Local + cloud hybrid | 9/10 | STRONG | EVO X2 (30B local, vision, embeddings, classifier) + MiniMax (cheap cloud) + Claude (premium cloud). Fallback chains, circuit breakers, cost routing. |
| 9 | Interface layer | 8/10 | STRONG | WhatsApp (chat), Rust dashboard (visual), voice (Piper TTS + Whisper STT), HTTP API, SSE. Missing: proactive notifications beyond briefings. |
| 10 | Safety & constraints | 8/10 | STRONG | Evolution scope guards, banned files, manifest validation, owner authority, quality gate, anti-slop rules. Missing: output fact-checking, tool result verification. |

**Overall: 81/100** — Phase 1 complete. Planning/reasoning jumped 4→7. Next gap: autonomous goal generation (Phase 2).

---

## Phase 1: Task Planner + Reasoning Traces (COMPLETE)

**Status:** Implemented. All code deployed locally, pending push to Pi/EVO.
**Spec:** `docs/superpowers/specs/2026-03-26-task-planner-reasoning-traces-design.md`

### Deliverables

1. **Reasoning traces** — Persist routing, engagement, model selection, and planning decisions to `data/reasoning-traces.jsonl`. Structured, queryable, feeds all downstream systems.

2. **4B classifier upgrade** — Qwen3-4B on EVO port 8085. Two-tier: 0.6B for engagement gating (fast binary), 4B for category + complexity + `needsPlan` classification (nuanced). Overnight coder targets 4B.

3. **Task planner** — Decompose multi-step requests into ordered, dependency-aware plans. Two-pass decomposition (sketch + refine via MiniMax). Parallel execution of independent steps. Failure recovery (local repair + suffix replan). Plans held in memory for diagnostics.

### Expected Impact

| Pillar | Before | After | Why |
|--------|--------|-------|-----|
| Planning & reasoning | 4/10 | 7/10 | Task decomposition, dependency tracking, replan on failure |
| Control layer | 7/10 | 8/10 | Reasoning traces enable introspection and learning |
| Multi-agent | 5/10 | 6/10 | Planner as distinct agent with own reasoning |

**Projected overall: 75 -> 81/100**

---

## Phase 2: Autonomous Goal Generation + Trace Analysis (IN PROGRESS)

**Status:** Core analysis + retrospective implemented. Dashboard visualisation pending.

### Deliverables

1. **Trace analyser** — `src/tasks/trace-analyser.js`. Runs daily at 3 AM. Reads `data/reasoning-traces.jsonl`, produces:
   - Routing layer breakdown (keywords vs 4B vs fallback percentages)
   - Category frequency distribution
   - Model selection patterns and reasons
   - Plan success/failure rates, avg steps, tool usage, failure reasons
   - needsPlan accuracy (precision, recall, F1 comparing predicted vs actual multi-tool usage)
   - Quality gate usage by category
   - Timing analysis (avg + p95 for routing and total response)
   - Anomaly detection (high fallback rate, plan failures, needsPlan false positives, slow routing, category imbalance)
   - Persists to `data/trace-analysis.json` + `data/trace-analysis-log.jsonl`

2. **Weekly retrospective** — `src/tasks/weekly-retrospective.js`. Runs Sunday 4 AM. Loads trace analysis history + self-improvement history, sends to EVO 30B for reasoning about top 3 improvement priorities. Each priority has: title, issue (with data), impact, fix (specific files), severity, evolution_instruction. Auto-creates evolution tasks for high/medium severity priorities. Persists to `data/weekly-retrospective.json` + `data/retrospective-log.jsonl`.

3. **API endpoints** — `/api/traces` (latest nightly analysis), `/api/traces/live` (on-demand 24h analysis), `/api/retrospective` (latest weekly retrospective). All authenticated.

4. **Overnight report integration** — Trace analysis and retrospective sections added to the nightly report (.txt and .pdf).

5. **needsPlan probing** — 23 synthetic test cases added to self-improvement cycle. Evaluates 4B classifier accuracy on needsPlan detection overnight.

6. **Dashboard plan visualisation** — *Not started.* Show active/recent plans, step status, trace data in Rust dashboard.

### Expected Impact

| Pillar | Before | After | Why |
|--------|--------|-------|-----|
| Self-improvement | 8/10 | 9/10 | Self-directed improvement from trace data |
| Control layer | 8/10 | 9/10 | Unified view of all cognitive decisions |

**Projected overall: 81 -> 85/100**

---

## Phase 2.5: Autonomous Group Participation

**Status:** Not started. Depends on Phase 2 trace data + engagement patterns.

### Deliverables

1. **Selective engagement** — Re-enable the dormant engagement classifier with a new architecture: the 4B classifier evaluates whether Clawd has something genuinely worth contributing (not just whether it was addressed). Factors: topic relevance from LQuorum knowledge, conversation momentum (is this winding down or active?), recency of last Clawd response, whether Clawd has unique knowledge the humans don't.

2. **Contribution quality gate** — Before autonomously responding in a group, draft the response and evaluate it against a "would James find this useful?" heuristic. If the answer is no or uncertain, stay silent. False positives (annoying interruptions) are worse than false negatives (missed contributions).

3. **Gradual ramp-up** — Start with "I know about this" signals (offering to help without just volunteering the answer), then graduate to direct contributions as confidence calibration improves.

4. **Group-specific personality** — Each group may have different norms. LQuorum: technical depth, legal precision. Friends: dry wit, minimal. Family: helpful, brief.

### Expected Impact

| Pillar | Before | After | Why |
|--------|--------|-------|-----|
| Multi-agent system | 6/10 | 7/10 | Autonomous engagement as a distinct agent |
| Interface layer | 8/10 | 9/10 | Proactive without being annoying |

**Projected overall: 85 -> 87/100**

---

## Phase 3: Predictive Scheduler + Inference Critique

**Status:** Not started. Depends on Phase 2 pattern recognition.

### Deliverables

1. **Predictive scheduler** — Anticipate needs from patterns. "Henry weekend coming, no trains booked." "Disclosure deadline Friday, no calendar block." Uses trace + memory + calendar data to identify gaps.

2. **Inference-time critique** — For PLANNING/LEGAL/complex responses: generate-then-challenge loop. MiniMax generates, then a second pass (same or different model) critiques before sending. Not the same as quality gate (which is post-hoc review) — this is pre-send debate.

3. **Tool result verification** — Cross-check tool outputs against expectations. "Calendar search returned 0 events for a weekday — is the date range correct?" Lightweight heuristic checks, not full LLM verification.

### Expected Impact

| Pillar | Before | After | Why |
|--------|--------|-------|-----|
| Planning & reasoning | 7/10 | 8/10 | Critique loop adds depth |
| Safety & constraints | 8/10 | 9/10 | Tool result verification catches errors |
| Interface layer | 8/10 | 9/10 | Proactive, anticipatory behaviour |

**Projected overall: 85 -> 89/100**

---

## Phase 4: World Model + Persistent Identity

**Status:** Conceptual. Depends on Phases 1-3 infrastructure.

### Deliverables

1. **World model** — Persistent structured model of James's world: people, relationships, projects, deadlines, preferences, routines. Not just memories — a graph. Updated by dream mode, queryable by planner.

2. **Persistent identity** — Soul system evolution from advisory personality traits to genuine self-model. Clawd maintains beliefs about its own capabilities, limitations, and improvement trajectory. Updated by retrospectives.

3. **Long-horizon planning** — Plans that span days/weeks. "Prepare for the mediation: draft chronology this week, review documents Thursday, brief Friday morning." Persistent plan state, not ephemeral.

### Expected Impact

**Projected overall: 89 -> 93/100** — Diminishing returns beyond this without fundamental model advances.

---

## Phase 5: Theoretical Ceiling

These require capabilities that may not exist yet in available models:

- **True causal reasoning** — Not pattern matching, actual causal inference
- **Genuine creativity** — Novel solutions not derived from training data
- **Robust common sense** — Consistent world knowledge without hallucination
- **Transfer learning at runtime** — Apply lessons from one domain to another without prompting

These are research problems, not engineering problems. Monitor model releases (Claude 5, GPT-6, Gemini 4) for breakthroughs. The architecture from Phases 1-4 will be ready to absorb them.

---

## Hardware: GMKTec NucBox EVO X2

| Component | Spec | Role |
|-----------|------|------|
| CPU | AMD Ryzen AI MAX+ 395 (16C/32T, Zen 5) | System, scheduler, Node.js |
| GPU | Radeon 8060S (RDNA 3.5, gfx1151) | Model inference via Vulkan RADV |
| Memory | 128GB LPDDR5X-8000 unified (~96GB usable for models) | Model weights + KV cache |
| Bandwidth | ~215 GB/s measured (256 GB/s theoretical) | Token generation bottleneck |
| NPU | XDNA 2, 50 TOPS | **Unusable** — no inference stack on Linux |
| Network | Direct ethernet to Pi (10.0.0.2), WiFi, Tailscale | Low-latency API serving |

### Current model allocation (~24GB of ~96GB)

| Port | Model | VRAM | Role |
|------|-------|------|------|
| 8080 | Qwen3-30B-A3B Q4_K_M | ~20GB | Main tool-calling, decomposition (--parallel 2) |
| 8081 | Qwen3-0.6B | ~0.5GB | Engagement classifier (YES/NO) |
| 8083 | nomic-embed-text | ~0.3GB | Embeddings for memory service |
| 8084 | Granite-Docling | ~1GB | Document parsing |
| 8085 | Qwen3-4B (Phase 1) | ~2.5GB | Category + needsPlan classifier |

~72GB free. Room for a second large model if needed in future phases.

### Bandwidth budget

Under worst-case concurrent load (30B + 4B generating simultaneously):
- 30B MoE (3B active): ~122 GB/s
- 4B: ~35 GB/s
- Total: ~157 GB/s — within 215 GB/s envelope

### Models to watch

- **Qwen3.5-35B-A3B** — Drop-in replacement for 30B. Better benchmarks, same active params.
- **NPU inference** — If llama.cpp or ONNX RT ever gets XDNA 2 support, the 0.6B classifier could move to NPU (always-on, zero GPU bandwidth).

---

## Tracking

| Phase | Started | Completed | Score Before | Score After |
|-------|---------|-----------|-------------|-------------|
| 1 | 2026-03-26 | 2026-03-26 | 75 | 81 |
| 2 | 2026-03-26 | — | 81 | — |
| 2.5 | — | — | — | — |
| 3 | — | — | — | — |
| 4 | — | — | — | — |
