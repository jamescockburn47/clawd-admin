# Refactoring Large Vibe-Coded Projects

A practical guide based on refactoring a 12,000+ line Node.js/Python system built primarily by AI agents over 3 months. Applicable to any codebase where AI wrote most of the code and humans provided direction.

---

## The Problem

Vibe coding produces working features fast. But the codebase degrades in predictable ways:

- **Files bloat.** AI adds code to existing files rather than creating new ones. A 200-line file becomes 1,400 lines because every feature gets appended to the "main" file.
- **Code duplicates.** AI doesn't know what exists elsewhere in your project. It writes a fresh HTTP client in every file that needs one. GitClear measured a 48% increase in copy-paste code across AI-assisted codebases (211M lines, 2020-2024).
- **Refactoring collapses.** In pre-AI codebases, ~25% of all code changes were refactoring. In AI-assisted codebases, it dropped below 10%. AI adds, it rarely improves.
- **Errors get swallowed.** AI generates `catch {}` blocks that look complete but log nothing. When something breaks at 3 AM, you have no trail.
- **Dead code accumulates.** Old versions of files survive alongside new ones. Disabled features keep running. Nobody cleans up because AI doesn't know what's stale.

CodeRabbit's analysis of 470 GitHub PRs found AI-generated code had 1.7x more issues overall, 2.74x more security vulnerabilities, 3x more readability issues, and 75% more logic errors than human-written code.

The good news: these problems are structural, not architectural. The AI usually gets the big decisions right (what to build, how components relate). It's the hygiene that falls apart. That's fixable without a rewrite.

---

## Before You Start

### 1. Map What You Have

Run a full codebase audit before touching anything:

- **File sizes.** Flag everything over 300 lines (JS) or 500 lines (Python). These are your split candidates.
- **Duplicate functions.** Search for identical function names across files. AI loves creating `fetchData()` in six different places.
- **Hardcoded values.** Grep for IP addresses, port numbers, timeout values, API URLs. Count how many files contain each.
- **Silent error handling.** Search for empty catch blocks (`catch {}`, `catch (_)`, `except:`, `except Exception: pass`).
- **Dead files.** Check for multiple versions of the same file. Check for files that nothing imports. Check for services that are running but unused.
- **Import graph.** Trace which files import which. Find god-files that everything depends on.

### 2. Verify You Can Deploy Safely

Before refactoring a single line:

- Have a way to verify the system works (health checks, test suite, eval baseline).
- Have a way to roll back if something breaks (git, backups, service restart).
- Know the exact deploy procedure (which files go where, what needs restarting).

Record your baseline. If you have an eval suite, run it and save the score. If you don't, at minimum verify the service starts and responds correctly. You'll re-check this number after every phase.

### 3. Decide Your Constraints

Set these before you start, not during:

- **Maximum file size.** ESLint's default is 300 lines. For AI-heavy codebases, some recommend 200 (smaller files are easier for AI to reason about). Python's Pylint default is 1,000 but 500 is more practical. Pick a number and enforce it.
- **Maximum function size.** Google's Python style guide suggests refactoring at ~40 lines. For JS, keep functions under 50 lines.
- **Deploy cadence.** Refactor in phases. Deploy and verify after each phase. Never batch more than one structural change into a single deploy — if it breaks, you need to know which change caused it.

---

## The Refactoring Process

### Phase 1: Shared Infrastructure

**What:** Create the shared utilities that duplicated code should have used.

This always comes first because everything else depends on it. Common targets:

- **HTTP client.** If multiple files make HTTP requests to the same services, create one client module with timeout handling, error logging, and circuit breakers. Every other file imports from this.
- **Config.** Centralise all environment variables, URLs, ports, and credentials into a single config module. Freeze the export (`Object.freeze()` in JS). No file should access `process.env` directly except the config module.
- **Constants.** Extract magic numbers (timeouts, buffer sizes, cooldowns, limits) into a constants module. Group by domain.

**How:**

1. Read every file that makes HTTP requests. Note the patterns — timeout handling, abort controllers, error logging. Pick the best implementation.
2. Create the shared module with that implementation.
3. Update every consumer to import from the shared module instead of defining its own.
4. Grep for hardcoded values (IPs, ports, timeouts). Move them to config/constants.
5. Deploy. Verify baseline. Move on only when clean.

### Phase 2: Split God-Files

**What:** Break files with multiple responsibilities into focused modules.

The rule: each file should be describable in one sentence without using "and." If you need "and," it's doing too much.

**How:**

1. Read the entire god-file. Identify natural boundaries — groups of functions that work together and don't depend on the rest.
2. For each group, create a new file. Move the functions. Update imports.
3. The original file becomes a thin orchestrator that wires the pieces together. It should import from the new modules and do nothing else.
4. Maintain backward compatibility — if other files import from the original, re-export from the new locations.
5. Deploy. Verify baseline.

**Common splits:**

| God-file pattern | Split into |
|-----------------|------------|
| Main entry point (does everything) | Entry point (wiring only) + message handler + HTTP server + background tasks |
| Scheduler (10 unrelated tasks) | Scheduler loop (just the timer) + one file per task in a `tasks/` directory |
| API client (HTTP + caching + logging + health checks) | HTTP client + domain-specific operations + cache layer |
| Report generator (data collection + rendering + sending) | Data collector + renderer + sender |

### Phase 3: Fix Error Handling

**What:** Make every error visible.

**Rules:**
- Every `catch` block logs with a structured logger (not `console.log`). Include: what failed, the error message, and enough context to debug.
- If silence is genuinely intentional (e.g., "expected to fail on first run"), add a comment explaining why.
- In Python, never use bare `except:` — it catches `SystemExit` and `KeyboardInterrupt`, making Ctrl+C non-functional. Always use `except Exception as e:` at minimum, and prefer specific exception types.
- Classify errors: operational (network timeout, invalid input — handle gracefully) vs programmer (null reference, wrong type — crash loudly, fix the bug).

### Phase 4: Delete Dead Code

**What:** Remove everything that isn't actively used.

- Stale file copies (the #1 vibe-coding artifact — AI creates a new version, old one survives).
- Disabled services that are still running (consuming memory, CPU, GPU for nothing).
- Legacy imports and adapter layers for tools you've migrated away from.
- Commented-out code blocks.
- Files that nothing imports (check with grep).

This is the phase people skip because it feels unproductive. It isn't. Dead code confuses AI agents that read your codebase — they don't know which version is current and may copy patterns from the stale one.

### Phase 5: Systemd / Infrastructure Audit

If your project runs as services:

- Every `Wants=` needs a corresponding `After=` (dependency without ordering means the dependency may not be ready).
- Verify service files point to the correct scripts (especially after renaming files).
- Remove disabled services from the repo (or clearly mark them as archived).
- Ensure all services log to journal (`StandardOutput=journal`).
- Check naming consistency.

### Phase 6: Governance Rules

**What:** Write the rules that prevent the codebase from degrading again.

This is the most important phase. Without it, the next AI session recreates the same mess.

Put these in whatever file your AI agents read (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `GEMINI.md`):

```
BEFORE WRITING ANY CODE:
1. Check the target file's line count. If over [your limit], split before adding.
2. Search for existing functions that do what you need.
3. Check constants/config for values you need — do not hardcode.
4. After writing, verify no file you touched exceeds the size limit.

RULES:
- Maximum file size: [N] lines. No exceptions without discussion.
- One file, one job. If you need "and" to describe it, split it.
- No duplicate functions. Search before writing.
- All external communication goes through the shared client.
- All constants in constants file or config file.
- Errors are never silently swallowed. Every catch logs.
- New scheduled tasks get their own file.
- Clean up after yourself. Delete old files when replacing them.
- Refactoring is mandatory. When touching a file that violates these rules, fix it.
```

The ALL-CAPS phrasing and imperative tone are deliberate — measurably improves AI agent compliance (per Claude Code best practices documentation).

---

## Adding Thorough Evals

An eval suite is the anchor that makes everything else safe. Without it, every refactor is a gamble. With it, you refactor with confidence and AI agents can self-validate their output.

### What to Eval

There are three layers, in order of priority:

**Layer 1: Routing & Classification (build this first)**

Your message router/classifier is the most critical code path — every user interaction passes through it. A regression here affects everything.

- **Build a labelled test set.** Take 200-300 real messages from your logs. Label each with the expected classification. Aim for 20-30 examples per category (the minimum for statistically meaningful per-class F1 scores, per Nuance Mix industry benchmarks).
- **Measure per-class F1.** Precision and recall per category. Overall accuracy is misleading when categories are imbalanced — a classifier that always says "chat" gets 60% accuracy but is useless.
- **Track hallucination rate.** If your classifier can invent categories not in the schema, count how often it does.
- **Run on every change.** If a prompt tweak or keyword rule change drops F1 for any category, you know immediately.

Example eval structure:
```json
[
  {"input": "what's the weather in York", "expected_category": "general_knowledge", "expected_tools": ["weather"]},
  {"input": "book me a train to London tomorrow", "expected_category": "travel", "expected_write_intent": true},
  {"input": "shut up clawd", "expected_action": "mute", "expected_response": null}
]
```

**Layer 2: Tool Execution (build second)**

Each tool should have golden-input/golden-output test cases:

- **Happy path.** Known input → expected output format. Calendar query returns events. Todo creation returns confirmation.
- **Error cases.** API down → graceful fallback. Invalid input → helpful error message, not crash.
- **Permission checks.** Non-owner tries restricted tool → blocked. Owner tries same tool → allowed.
- **Mock external APIs.** Tests must run offline. Mock Google, weather, train APIs with fixture data.

Use `node:test` and `node:assert` (built-in, no framework dependency):
```javascript
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';

describe('calendar tool', () => {
  it('returns events for valid date range', async () => {
    // mock Google Calendar API
    // call tool handler
    // assert response shape and content
  });
});
```

**Layer 3: Response Quality (build third, if using LLMs)**

This is where LLM-as-judge comes in. Use it for subjective quality assessment:

- **Anti-slop check.** Does the response contain banned phrases, excessive bullets, filler language?
- **Relevance.** Does the response actually answer the question?
- **Tone.** For personality-driven bots, does the response match the configured personality?
- **Length.** Is the response appropriately sized (not truncated, not bloated)?

Tools: **promptfoo** (YAML-driven, CI-native, no vendor lock-in), **DeepEval** (pytest-native, 60+ metrics), or roll your own with a simple LLM-as-judge prompt. LLM-as-judge aligns with human judgment at ~85%, which exceeds human-to-human agreement at 81% (Confident AI research).

### How Many Tests

| Layer | Minimum | Good | Comprehensive |
|-------|---------|------|---------------|
| Routing/classification | 100 cases | 300 cases (20-30 per category) | 500+ with adversarial edge cases |
| Tool execution | 3 per tool (happy, error, edge) | 5-10 per tool | 20+ per tool with combinatorial inputs |
| Response quality | 20 golden examples | 50 examples across categories | 100+ with LLM-as-judge scoring |

### When to Run Evals

- **On every code change that touches routing, prompts, or tools.** Non-negotiable.
- **On every AI-generated PR/branch.** Before presenting the diff for human review. This is the highest-leverage addition for vibe-coded projects — it catches regressions before they consume your review time.
- **Nightly.** Full suite against the production config. Catches drift from model updates, API changes, data shifts.
- **Before and after every refactor phase.** The baseline must not drop.

### Eval-Gated Deploys

The goal is to make evals a hard gate, not an optional check:

```
Code change → Syntax check → Eval suite → Pass? → Present for review
                                        → Fail? → Auto-reject, log why
```

For AI agent workflows (overnight coder, evolution pipeline), add eval as a post-execution step:

1. Agent writes code in a branch.
2. `node --check` on all modified files (syntax).
3. Run routing eval — must maintain or improve baseline.
4. Run tool tests on any modified tool files.
5. Only then present the diff for human review.

If any step fails, the branch is auto-rejected and the failure reason is logged. This turns your eval suite into a safety net that works while you sleep.

### Building Evals From Existing Data

If your system logs interactions (and it should), you already have eval data:

1. **Mine your logs.** Pull real messages with their actual routing decisions. Sample across categories.
2. **Label retroactively.** For each message, confirm or correct the classification. This is tedious but you only do it once — after that, new cases are added incrementally.
3. **Use failures as test cases.** Every bug you fix becomes a regression test. Every misclassification you spot becomes a new eval case. The suite grows organically.
4. **Adversarial cases.** Deliberately craft messages designed to confuse the classifier: ambiguous intent, mixed categories, unusual phrasing, messages that mention the bot without addressing it.

### The Golden Rule

Simon Willison's principle for vibe-coded projects: "If your project has a robust, comprehensive and stable test suite, agentic coding tools can fly with it."

The eval suite is not overhead. It is the thing that makes AI-assisted development safe. Without it, every AI contribution is a gamble. With it, AI agents become genuinely useful — they can self-validate, catch their own mistakes, and maintain quality without constant human oversight.

---

## Checklist

Use this as a pre-flight checklist before starting a refactor:

- [ ] Full codebase audit complete (file sizes, duplicates, hardcoded values, dead code)
- [ ] Baseline eval score recorded
- [ ] Deploy and rollback procedures verified
- [ ] Maximum file size limit chosen and documented
- [ ] Shared infrastructure created (HTTP client, config, constants)
- [ ] God-files split into focused modules
- [ ] Error handling standardised (no silent catches)
- [ ] Dead code deleted (stale files, disabled services, legacy adapters)
- [ ] Infrastructure audited (service dependencies, naming, logging)
- [ ] Governance rules written in agent instruction files
- [ ] Routing eval suite built (200+ labelled cases)
- [ ] Tool execution tests written (happy path + error + edge per tool)
- [ ] Evals integrated into CI/deploy pipeline
- [ ] Eval baseline re-verified after refactor (must match or improve)

---

## References

- GitClear, "AI Copilot Code Quality 2025 Research" — 211M lines analysed, copy-paste code up 48%, refactoring down to <10%
- CodeRabbit, "AI-Generated Code Quality Analysis" — 470 PRs, 1.7x more issues, 2.74x more security vulnerabilities
- METR, "Randomised Controlled Trial of AI Coding Assistants" — 16 developers, 19% slower on real tasks despite perceiving 20% faster
- Simon Willison, "Vibe Engineering" (October 2025) — 11 practices for responsible AI-assisted development
- Kent Beck, "Augmented Coding: Beyond the Vibes" — TDD + mandatory review for AI-generated code
- ESLint, "max-lines rule" — default 300 lines per file
- Nuance Mix, "Evaluating NLU Accuracy" — minimum 20 utterances per intent for statistical significance
- Confident AI, "LLM-as-Judge" — 85% alignment with human judgment (exceeds human-human agreement at 81%)
- Promptfoo documentation — YAML-driven eval configs, CI/CD integration
- Claude Code Best Practices — ALL-CAPS phrasing improves agent compliance
