# Archived Design Decisions

> Decisions moved from CLAUDE.md because they are either:
> 1. **Superseded** by later decisions
> 2. **Implementation details** the agent can infer from reading the code
> 3. **Historical facts** about completed one-time work
>
> CLAUDE.md now contains only non-inferable constraints and invariants.

## Superseded Decisions

### Evolution Pipeline (Original — 2026-03-25) → The Forge (#150-160)
59. Self-coding via Claude Code CLI on EVO. All changes in git branches.
60. evolution_task WhatsApp tool. Owner-only, queued, max 3/day.
63. Dream mode can create evolution tasks via POST /api/evolution/task.
70. Evolution tasks are triple-gated. Code-level block + DM confirm ID + 10 min expiry.
76. Overnight evolution: one fix per session.
80. Evolution pipeline uses MiniMax on EVO. Claude as fallback.
85. Opus post-review of overnight coding results.
103. Weekly retrospective Sunday 4 AM. → Now daily at 4 AM (#147).

### Duplicates
17. Fix general before specific (repeated for emphasis). → Consolidated into #11.

### Historical
13. Data collection layers complete. → Built and running.

## Implementation Details (Inferable from Code)

> These were moved because the agent can read the code to find them. Keeping them in CLAUDE.md created context rot — stale descriptions of values that had moved on.

### Classifier & Router Internals
42. [SILENT] marker filtered in index.js.
46. buildContext includes current message.
47. Startup message only on version change.
48. Google OAuth dead flag.
49. BOT_NAMES excludes 'claude'. Only clawd|clawdbot.
50. LQuorum topics NOT injected into classifier.
51. Keywords run before complexity detection in router.
52. Message deduplication. Last 200 message IDs.
53. Opus critique stripping uses --- divider.
100. mightNeedPlan() and detectComplexity() removed.
101. Task planner uses 30B model on port 8080, not 8085.
110. Passive mode removed from trigger.js.

### LQuorum Working Memory
36. Passive keyword scanning warms working memory. 18 topics.
37. Direct queries use warmFromQuery() with no length filter.
38. Working memory decays after 15 minutes.

### Dream Mode Housekeeping
55. Dream orientation phase (Phase 0). Fetches existing memories.
56. Pre-store dedup + contradiction detection. Similarity > 0.85 = skip.
57. Stale memory pruning (Phase 5). 30-day decay, protected exempt.
58. Verbatim excerpt storage. Exact quotes, 0.95 confidence.
140. Dream diary novelty-aware. Yesterday's diary injected.
141. Minimum 10 messages for full diary.
142. Dynamic diary token budget: min(1200, max(300, msg_count * 15)).
146. Diary quality metrics in report.

### Memory System Thresholds
125. Pre-store dedup at 0.92 cosine threshold.
126. Scheduled maintenance runs overnight at 2 AM.
128. Memory injection token budget: 3000 tokens (~12000 chars).
129. Embedding model: Qwen3-Embedding-8B (4096d). Port 8083.
130. EVO memory service DATA_DIR is ~/clawdbot-memory/data.
131. Memory scoring source weights: system×1.25, conversation×1.0, dream×0.90.
133. Contradiction suppression cosine ≥ 0.75.
134. Frequency score removed from search.
135. Auto-supersession at store time (0.70–0.91 cosine).
136. BM25 + vector search via RRF.
166. RRF rebalanced: rrf * 12.0 + 0.25 * recency + 0.30 * eff_conf.
167. Contradiction suppression threshold raised to 0.83.
168. BM25 tags tokenised through _tokenise().
169. Embedding calls batched in llm_client.py.

### Cortex Internals
162. Speculative web prefetch on heuristic match. Cached 60s.
163. Web prefetch cache-only, never injected into prompt.
164. Category-based late prefetch for GENERAL_KNOWLEDGE or PLANNING.

### Trace Analysis & Overnight Pipeline
102. Trace analyser runs daily 3 AM. File paths and outputs.
104. Trace diagnostics API endpoints.
105. Overnight report includes trace analysis and retrospective.
106. needsPlan probing — 23 synthetic test cases.
144. Evolution pipeline section in overnight report.
145. Self-improvement results human-readable.

### Group Analysis Internals
119. Pending action system — in-memory Map, 5-minute expiry.
120. Topic index built overnight on EVO 30B. data/topic-index/.
124. File locations for group analysis modules.

### Evolution Bridge & UI
146b. overnight-to-evolution.js bridges analysis to tasks. 5 AM.
147. Retrospective runs DAILY 4 AM (bootstrap period).
148. Live Monitor shows ALL messages. /api/messages endpoint.
149. Memory cards show 6 lines before truncation.

### Ground Truth & Pipeline Order
171. Ground truth harvester at 03:30. Max 10 claims/night.
