# Aristotle Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-step "Aristotle mode" group analysis command that deconstructs discussions using first principles reasoning.

**Architecture:** Reuses existing `getGroupModeResponse()` pipeline from `claude.js` with Opus. No pending actions — single-step trigger-to-response. Quoted messages get priority as focal point; otherwise grabs recent chat transcript. Output filter applied identically to other group modes.

**Tech Stack:** Node.js ESM, Baileys (WhatsApp message context), existing EVO/Opus infrastructure.

**Deploy:** SSH to Pi via Tailscale (`100.104.92.87`), rsync + systemctl restart.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/group-modes.js` | Modify | Add `ARISTOTLE_PATTERN`, `detectGroupMode()` branch, `buildAristotlePrompt()` |
| `src/message-handler.js` | Modify | Add aristotle single-step execution branch before two-step modes |
| `src/trigger.js` | No change needed | Exit patterns in `group-modes.js` already cover aristotle |

---

### Task 1: Add Aristotle trigger detection to group-modes.js

**Files:**
- Modify: `src/group-modes.js:9-43`

- [ ] **Step 1: Add ARISTOTLE_PATTERN constant**

After `SUMMARY_PATTERN` (line 12), add:

```javascript
const ARISTOTLE_PATTERN = /\b(aristotle|first\s*principles?\s*(deconstruct|analy[sz]e?|mode)?)\b/i;
```

- [ ] **Step 2: Add aristotle to EXIT_PATTERN and EXIT_PATTERN_REVERSE**

Replace lines 13-14 with:

```javascript
const EXIT_PATTERN = /\b(exit|stop|cancel|quit|leave|drop|never\s*mind|forget\s*it)\b.*\b(mode|advocate|summary|summari[sz]e|critique|analysis|aristotle|first\s*principles?)\b/i;
const EXIT_PATTERN_REVERSE = /\b(mode|advocate|summary|summari[sz]e|critique|analysis|aristotle|first\s*principles?)\b.*\b(exit|stop|cancel|quit|off)\b/i;
```

- [ ] **Step 3: Add aristotle branch to detectGroupMode()**

Add after the summary check (line 41):

```javascript
if (ARISTOTLE_PATTERN.test(text)) return { mode: 'aristotle' };
```

Update the JSDoc return type on line 37:

```javascript
 * @returns {{ mode: 'critique'|'summary'|'aristotle' }|null}
```

- [ ] **Step 4: Commit**

```bash
git add src/group-modes.js
git commit -m "feat(aristotle): add trigger detection for aristotle/first principles mode"
```

---

### Task 2: Add buildAristotlePrompt to group-modes.js

**Files:**
- Modify: `src/group-modes.js` (append after `buildSummaryPrompt`, before `executeGroupMode`)

- [ ] **Step 1: Add buildAristotlePrompt function**

Insert after `buildSummaryPrompt()` (after line 191), before `executeGroupMode()` (line 202):

```javascript
/**
 * Build the Aristotle first principles deconstruction prompt.
 * Adaptive depth: Opus decides condensed vs full 5-phase based on complexity.
 * @param {string} transcript - Conversation transcript
 * @param {string|null} quotedText - Specific quoted message to focus on, or null
 * @returns {string}
 */
export function buildAristotlePrompt(transcript, quotedText) {
  const focusSection = quotedText
    ? `## FOCAL POINT\nThe user has highlighted this specific message for deconstruction:\n"${quotedText}"\n\n## SURROUNDING CONTEXT\n${transcript}`
    : `## DISCUSSION TO DECONSTRUCT\nIdentify the main thrust of this group discussion and deconstruct it.\n\n${transcript}`;

  return `You are Clawd in Aristotle mode — a first principles deconstructor. You analyse discussion to find what is actually true versus what is assumed.

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

${focusSection}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/group-modes.js
git commit -m "feat(aristotle): add first principles deconstruction prompt builder"
```

---

### Task 3: Wire Aristotle mode into message-handler.js

**Files:**
- Modify: `src/message-handler.js:1-21` (imports)
- Modify: `src/message-handler.js:242-305` (group modes section)

- [ ] **Step 1: Update imports**

On line 20, add `buildAristotlePrompt` to the import:

```javascript
import { detectGroupMode, detectGroupModeExit, detectTopicSelection, runTopicRetrieval, executeGroupMode, buildExecutionPrompt, buildAristotlePrompt } from './group-modes.js';
```

Also import `getRecentGroupMessages` and `formatTranscript` from topic-scan.js. Add after line 21:

```javascript
import { getRecentGroupMessages, formatTranscript } from './topic-scan.js';
```

- [ ] **Step 2: Add aristotle execution branch**

In the group modes section, after the exit check (line 248) and BEFORE the pending topic selection check (line 251), insert the aristotle handler. The aristotle mode check must come before `detectTopicSelection` because aristotle is single-step and should not interact with pending actions from other modes.

Insert after line 248 (`// Pending action already cleared...`), before line 250 (`// Check for pending topic selection`):

```javascript
      // Aristotle mode — single-step, no topic selection
      const aristotleMode = !isExitRequest && detectGroupMode(messageText);
      if (aristotleMode && aristotleMode.mode === 'aristotle') {
        logger.info({ chatJid }, 'aristotle mode triggered');
        await simulateTyping(sock, chatJid, 500);

        // Extract quoted message if present
        const quotedText = message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation
          || message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text
          || null;

        // Build transcript — recent group messages
        const recentMessages = getRecentGroupMessages(chatJid, quotedText ? 15 : 50);
        const transcript = formatTranscript(recentMessages);

        if (!transcript && !quotedText) {
          const noDataMsg = 'Not enough recent conversation to deconstruct.';
          await sock.sendMessage(chatJid, { text: noDataMsg });
          return;
        }

        const systemPrompt = buildAristotlePrompt(transcript, quotedText);
        const userMsg = quotedText
          ? 'Deconstruct the highlighted message to its foundation using the surrounding context.'
          : 'Analyse the main thrust of this group discussion and deconstruct it to its foundation.';

        const aristotleResponse = await getGroupModeResponse(
          systemPrompt, userMsg,
          true, // useOpus — first principles reasoning needs the strongest model
          senderJid, chatJid
        );

        const finalText = aristotleResponse || 'Failed to complete the analysis. Try again.';

        // Apply output filter
        const filterResult = filterResponse(finalText, chatJid);
        const safeText = filterResult.safe ? finalText : getBlockedResponse(filterResult.reason);

        await simulateTyping(sock, chatJid, safeText.length);
        const chunks = splitMessage(safeText);
        for (const chunk of chunks) {
          const sent = await sock.sendMessage(chatJid, { text: chunk });
          if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
          if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
        }
        pushMessage(chatJid, { senderName: 'Clawd', text: safeText, hasImage: false, isBot: true });
        if (config.evoMemoryEnabled) {
          try { logConversation(chatJid, [{ senderName: 'Clawd', text: safeText, isBot: true }]); } catch {}
        }
        return;
      }
```

- [ ] **Step 3: Adjust existing detectGroupMode call to avoid double-detection**

The existing `detectGroupMode` call on line 285 will now also match aristotle. Since we've already handled aristotle above, we need to guard it. Replace line 285:

```javascript
      const groupMode = !isExitRequest && !aristotleMode && detectGroupMode(messageText);
```

Note: `aristotleMode` was declared in step 2 above. If `aristotleMode` was set but wasn't `'aristotle'` (impossible currently, but defensive), the existing two-step flow still runs.

- [ ] **Step 4: Commit**

```bash
git add src/message-handler.js
git commit -m "feat(aristotle): wire single-step first principles deconstruction into message handler"
```

---

### Task 4: Deploy to Pi via Tailscale

**Files:**
- No file changes — deployment only

- [ ] **Step 1: Verify Pi is reachable**

```bash
ping -c 1 100.104.92.87
```

Expected: reply from `100.104.92.87`

- [ ] **Step 2: Rsync changed files to Pi**

```bash
rsync -avz --include='src/group-modes.js' --include='src/message-handler.js' --include='src/topic-scan.js' --filter='- *' -e "ssh -i C:/Users/James/.ssh/id_ed25519" . pi@100.104.92.87:~/clawdbot/
```

Or if rsync is awkward on Windows, SCP the two changed files:

```bash
scp -i C:/Users/James/.ssh/id_ed25519 src/group-modes.js pi@100.104.92.87:~/clawdbot/src/group-modes.js
scp -i C:/Users/James/.ssh/id_ed25519 src/message-handler.js pi@100.104.92.87:~/clawdbot/src/message-handler.js
```

- [ ] **Step 3: Restart clawdbot service**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@100.104.92.87 "sudo systemctl restart clawdbot && sleep 2 && sudo systemctl status clawdbot --no-pager -l"
```

Expected: `active (running)`

- [ ] **Step 4: Check logs for clean startup**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@100.104.92.87 "journalctl -u clawdbot --no-pager -n 20"
```

Expected: No errors, `WhatsApp connection ready` or similar.

- [ ] **Step 5: Commit deployment note**

```bash
git add docs/superpowers/specs/2026-04-01-aristotle-mode-design.md docs/superpowers/plans/2026-04-01-aristotle-mode.md
git commit -m "docs: aristotle mode design spec and implementation plan"
```

---

### Task 5: Test in WhatsApp

- [ ] **Step 1: Test bare trigger in a group**

Send `@clawd aristotle` in a group with recent conversation.

Expected: Clawd grabs recent messages, sends a first principles deconstruction (condensed or full depending on complexity). No topic selection step.

- [ ] **Step 2: Test with quoted message**

Quote a specific message in the group, then send `@clawd first principles`.

Expected: Clawd focuses on the quoted message, uses surrounding messages as context.

- [ ] **Step 3: Test exit**

Send `@clawd exit aristotle` while typing indicator is showing.

Expected: No crash, graceful handling. (Exit mostly matters if someone triggers it and the response hasn't come back yet — edge case.)

- [ ] **Step 4: Test with insufficient conversation**

Send `@clawd aristotle` in a group with no recent messages.

Expected: "Not enough recent conversation to deconstruct."

- [ ] **Step 5: Verify output filter**

In a colleague-mode group, trigger aristotle mode. Verify response doesn't leak personal admin or blocked topics.

---

### Task 6: Update CLAUDE.md with design decision

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Aristotle mode design decision**

Add after decision 135 (or the current last numbered decision):

```markdown
### Aristotle Mode (2026-04-01)
136. **Aristotle mode is single-step, not two-step.** No topic selection. Grabs recent chat or quoted message, sends directly to Opus with 5-phase first principles framework. Adaptive depth (condensed vs full) decided by model.
137. **Anyone can trigger aristotle mode in groups.** Not owner-only. Trigger: "aristotle", "first principles". Works in DMs too.
138. **Quoted messages take priority as focal point.** If the trigger message quotes another message, that message is the deconstruction target. Otherwise, recent ~50 messages scanned for main thrust.
```

Note: Check the actual last decision number in CLAUDE.md before inserting — it may have changed since the spec was read.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add aristotle mode design decisions to CLAUDE.md"
```
