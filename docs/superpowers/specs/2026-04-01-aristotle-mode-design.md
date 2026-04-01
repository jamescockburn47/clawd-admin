# Aristotle Mode — First Principles Deconstructor

> **Status:** Approved
> **Date:** 2026-04-01
> **Scope:** Single-step group analysis mode for Clawd

## Overview

Aristotle mode is a one-shot analytical command that deconstructs a group chat discussion (or a specific quoted message) using first principles reasoning. It strips assumptions, identifies irreducible truths, and reconstructs conclusions from scratch.

Unlike devil's advocate and summary modes, Aristotle mode is **single-step** — no topic selection, no pending actions. Trigger it, get the analysis.

## Trigger

**Activation pattern:**
```
/\b(aristotle|first\s*principles?\s*(deconstruct|analy[sz]e?|mode)?)\b/i
```

Matches: "aristotle", "aristotle mode", "first principles", "first principles deconstruct", "first principles analysis", "first principles analyze".

**Exit pattern (added to existing exit detection):**
```
/\b(exit|stop|cancel)\b.*\b(aristotle|first\s*principles)\b/i
/\b(aristotle|first\s*principles)\b.*\b(exit|stop|cancel|off)\b/i
```

**Who can trigger:** Anyone in a group chat, or James in DMs.

## Input Selection

Priority order:

1. **Quoted/forwarded message present** — Use the quoted message as the focal point. Grab ~10 surrounding messages from the conversation log for context.
2. **Bare trigger (no quote)** — Grab last ~50 human messages from today's conversation log via `getRecentGroupMessages()`. The model identifies the main thrust of discussion.

## Execution Flow

```
User sends "aristotle" or "first principles"
  │
  ├─ detectGroupMode() returns { mode: 'aristotle' }
  │
  ├─ message-handler.js:
  │   ├─ Check for quoted message context
  │   ├─ Get transcript (quoted + surrounding OR recent 50)
  │   ├─ buildAristotlePrompt(transcript, quotedMessage)
  │   ├─ getGroupModeResponse(prompt, userMsg, useOpus=true, senderJid, chatJid)
  │   ├─ filterResponse() — standard group security
  │   ├─ splitMessage() + send
  │   └─ return (no pending action stored)
  │
  └─ Done. No state to clean up.
```

## System Prompt

```
You are Clawd in Aristotle mode — a first principles deconstructor. You analyse discussion to find what is actually true versus what is assumed.

Execute the following analytical sequence on the discussion provided.

## ADAPTIVE DEPTH

Assess the complexity of the discussion:
- **Simple** (single issue, clear positions): Use CONDENSED format.
- **Complex** (multi-faceted, entangled assumptions, significant stakes): Use FULL format.

### CONDENSED FORMAT (simple topics)

# ASSUMPTIONS
List the key assumptions embedded in this discussion (3-5 bullets). Flag which are borrowed from convention, fear, or received wisdom.

# IRREDUCIBLE TRUTHS
Strip to what is verifiably, undeniably true. Numbered list.

# RECONSTRUCTION
Using only the truths above, what conclusion or approach would you reach if starting from zero?

# THE ARISTOTELIAN MOVE
The single highest-leverage insight that conventional thinking would miss.

### FULL FORMAT (complex topics)

# PHASE 1: ASSUMPTION AUTOPSY
Identify every assumption embedded in the discussion. List each explicitly. Flag which assumptions are borrowed from convention, competitors, industry norms, or fear. Explain why each is not a fundamental truth.

# PHASE 2: IRREDUCIBLE TRUTHS
Strip the situation to only what is verifiably, undeniably true. Remove what is generally accepted, what competitors do, what worked before. Present as a numbered list of foundational truths.

# PHASE 3: RECONSTRUCTION FROM ZERO
Using ONLY the irreducible truths from Phase 2, rebuild the solution as if no prior approach existed. If solving this for the first time with no knowledge of how anyone else has done it, what would we build? Generate three distinct, highly actionable reconstructed approaches, each starting purely from first principles.

# PHASE 4: ASSUMPTION VS. TRUTH MAP
Create a comparison table:
| Assumption | First Principle | Where convention misleads vs. where the new foundation leads |

# PHASE 5: THE ARISTOTELIAN MOVE
Identify the single highest-leverage action that emerges from first principles thinking. This must be a move that conventional analysis would never surface because it requires abandoning widely held assumptions. Present as a clear, specific, immediately executable recommendation.

## OUTPUT RULES
- Direct, uncompromising, clear language.
- Zero filler, zero hedging, zero pleasantries, zero emojis.
- Attribute positions to specific people where the transcript supports it.
- Use memory_search and web_search to ground analysis in facts where relevant.
- If the discussion lacks enough substance to deconstruct meaningfully, say so in one sentence rather than forcing a shallow analysis.
```

**User message (with quoted message):**
```
Deconstruct this to its foundation:

"${quotedText}"

Context from surrounding discussion:
${surroundingTranscript}
```

**User message (bare trigger):**
```
Analyse the main thrust of this group discussion and deconstruct it to its foundation:

${recentTranscript}
```

## Model & Tools

- **Model:** Opus (`useOpus=true`). First principles reasoning requires the strongest model.
- **Tools:** `memory_search`, `web_search`, `web_fetch` — same as devil's advocate. Grounds reconstruction in real data.
- **max_tokens:** 4000 (standard for substantive responses).

## Files to Modify

| File | Change | Lines affected (approx) |
|------|--------|------------------------|
| `src/group-modes.js` | Add `ARISTOTLE_PATTERN`, add to `detectGroupMode()`, add `buildAristotlePrompt()` | +30-40 lines |
| `src/trigger.js` | Add aristotle terms to exit pattern | +2 lines |
| `src/message-handler.js` | Add aristotle branch in group modes section — single-step, no pending action | +25-30 lines |

**No new files.** No changes to `pending-action.js`, `topic-index.js`, `topic-scan.js`, `claude.js`, or `output-filter.js`.

## What Aristotle Mode Does NOT Do

- No persistent mode state (one-shot command, not a toggle)
- No topic selection step (always immediate)
- No overnight indexing
- No new tools or API endpoints
- No changes to the pending action system

## Security

- Output filter applied identically to all other group responses
- Group mode restrictions (open/project/colleague) enforced
- Anti-prompt-injection hardening applies (same system prompt wrapping)
- No new attack surface — uses existing `getGroupModeResponse()` pipeline

## Testing

Trigger in a group chat:
1. Bare: "@clawd aristotle" — should grab recent chat and deconstruct
2. With quote: Quote a message, then "@clawd first principles" — should focus on quoted message
3. Exit: "exit aristotle" mid-typing indicator — should cancel
4. Security: Verify output filter blocks restricted content in non-open groups
