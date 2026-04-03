# Archived Design Decisions

> Decisions that have been superseded by later decisions or describe completed one-time work.
> Moved here to keep CLAUDE.md focused on active, enforceable rules.
> Each entry notes what superseded it.

## Evolution Pipeline (Original — 2026-03-25)
*Superseded by The Forge (#150-160)*

59. **Self-coding via Claude Code CLI on EVO.** All changes in git branches.
60. **evolution_task WhatsApp tool.** Owner-only, queued, max 3/day.
63. **Dream mode can create evolution tasks** via POST `/api/evolution/task`.
70. **Evolution tasks are triple-gated.** Code-level block + DM confirm ID + 10 min expiry.
76. **Overnight evolution: one fix per session.**
80. **Evolution pipeline uses MiniMax on EVO.** Claude as fallback.
85. **Opus post-review of overnight coding results.**

> These described the pre-Forge evolution system. The Forge (#150-160) replaces the orchestration model.
> Core safety principles (DM approval #61, deploy flow #62, scope limits #71-75) remain active in CLAUDE.md.

## Scheduling (Original)
*Superseded by #147*

103. **Weekly retrospective runs Sunday 4 AM.** — Now daily at 4 AM during bootstrap period (#147).

## Process (Duplicate)

17. **Fix general before specific** (repeated for emphasis). — Duplicate of #11, consolidated.

## Data Collection

13. **Data collection layers complete**: interaction logging, reaction feedback, correction detection, dream diary. — Historical fact, not an ongoing rule. Layers are built and running.
