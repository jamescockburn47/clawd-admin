// src/group-modes.js — Devil's Advocate and Summary mode execution
// Two-step flow: topic retrieval (index + live) → execution.
// Historical topics come from overnight topic index (free, pre-computed on EVO).
// Today's topics are clustered live via EVO 30B on demand.
import { getGroupTopics, formatTopicsForSelection, getTranscriptForSelection } from './topic-index.js';
import { setPendingAction, getPendingAction, clearPendingAction, parseTopicSelection } from './pending-action.js';
import logger from './logger.js';

// ── TRIGGER DETECTION ────────────────────────────────────────────────────────

const DEVILS_ADVOCATE_PATTERN = /\bdevil[\u2018\u2019'']?s?\s*advocate\b/i;
const SUMMARY_PATTERN = /\b(summari[sz]e|summary|recap|catch me up|what did i miss|what have i missed)\b/i;
const EXIT_PATTERN = /\b(exit|stop|cancel|quit|leave|drop|never\s*mind|forget\s*it)\b.*\b(mode|advocate|summary|summari[sz]e|critique|analysis)\b/i;
const EXIT_PATTERN_REVERSE = /\b(mode|advocate|summary|summari[sz]e|critique|analysis)\b.*\b(exit|stop|cancel|quit|off)\b/i;

/**
 * Check if a message is an exit/cancel command for group analysis mode.
 * Must be checked BEFORE detectGroupMode since "exit devil's advocate" contains the trigger.
 * Also clears any pending action for the group.
 * @param {string} text - Message text (after bot prefix stripping)
 * @param {string} chatJid - Group JID
 * @returns {boolean}
 */
export function detectGroupModeExit(text, chatJid) {
  if (!text) return false;
  if (EXIT_PATTERN.test(text) || EXIT_PATTERN_REVERSE.test(text)) {
    clearPendingAction(chatJid);
    return true;
  }
  return false;
}

/**
 * Check if a message triggers a group analysis mode.
 * @param {string} text - Message text (after bot prefix stripping)
 * @returns {{ mode: 'critique'|'summary' }|null}
 */
export function detectGroupMode(text) {
  if (!text) return null;
  if (DEVILS_ADVOCATE_PATTERN.test(text)) return { mode: 'critique' };
  if (SUMMARY_PATTERN.test(text)) return { mode: 'summary' };
  return null;
}

/**
 * Check if a message is a topic selection reply to a pending action.
 * @param {string} text - Message text
 * @param {string} chatJid - Group JID
 * @returns {{ action: PendingAction, selectedTopics: number[]|'all' }|null}
 */
export function detectTopicSelection(text, chatJid) {
  const action = getPendingAction(chatJid);
  if (!action) return null;

  const selection = parseTopicSelection(text, action.totalTopics || action.topics.length);
  if (!selection) return null;

  return { action, selectedTopics: selection };
}

// ── STEP 1: TOPIC RETRIEVAL ─────────────────────────────────────────────────

/**
 * Retrieve topics from topic index (historical) + live messages (today).
 * No LLM call needed for historical topics — they're pre-indexed overnight.
 * Today's messages are clustered on-demand via EVO 30B (free).
 *
 * @param {string} chatJid - Group JID
 * @param {string} mode - 'critique' or 'summary'
 * @returns {string} - WhatsApp message with numbered topic list
 */
export async function runTopicRetrieval(chatJid, mode) {
  try {
    const { historical, today, transcript } = await getGroupTopics(chatJid, 3);

    const totalTopics = today.length + historical.length;

    if (totalTopics === 0) {
      return "Not enough recent conversation to analyse. I need at least a few messages.";
    }

    // Build combined topic list for numbering
    const allTopics = [];
    let num = 1;
    for (const t of today) allTopics.push({ ...t, displayNum: num++ });
    for (const t of historical) allTopics.push({ ...t, displayNum: num++ });

    // If only one topic, skip selection
    if (totalTopics === 1) {
      const t = allTopics[0];
      setPendingAction(chatJid, mode, allTopics, transcript, { historical, today });
      const modeLabel = mode === 'critique' ? 'critique' : 'summarise';
      return `I can see one topic: *${t.label}*${t.summary ? ` — ${t.summary}` : ''}.\n\nShall I ${modeLabel} it? Reply "yes" or "1".`;
    }

    // Store for step 2 — include historical/today split for transcript retrieval
    setPendingAction(chatJid, mode, allTopics, transcript, { historical, today });
    return formatTopicsForSelection(historical, today, mode);
  } catch (err) {
    logger.error({ err: err.message, chatJid, mode }, 'topic retrieval failed');
    return "Failed to analyse the conversation. Try again in a moment.";
  }
}

// ── STEP 2: MODE EXECUTION ──────────────────────────────────────────────────

/**
 * Build the execution prompt for selected topics.
 *
 * @param {PendingAction} action - The pending action with transcript and topics
 * @param {number[]|'all'} selection - Selected display numbers or 'all'
 * @returns {string} - System prompt for the execution LLM call
 */
export function buildExecutionPrompt(action, selection) {
  const selectedTopics = selection === 'all'
    ? action.topics
    : action.topics.filter(t => selection.includes(t.displayNum || t.number));

  const topicLabels = selectedTopics.map(t => t.label).join(', ');

  // Get transcript for selected topics (today's live + historical from logs)
  let transcript = action.transcript;
  if (action.topicData) {
    transcript = getTranscriptForSelection(
      action.topicData.historical, action.topicData.today,
      action.transcript, selection
    );
  }

  if (action.mode === 'critique') {
    return buildCritiquePrompt(transcript, topicLabels, selectedTopics);
  }
  return buildSummaryPrompt(transcript, topicLabels, selectedTopics);
}

function buildCritiquePrompt(transcript, topicLabels, selectedTopics) {
  return `You are in Devil's Advocate mode. Your job is to find gaps, blind spots, and groupthink in this group conversation. Be substantive, not theatrical — ground every challenge in evidence.

## Topics to critique: ${topicLabels}

## Framework (use ALL of these)

1. **The group's position** — State the emerging consensus in 1-2 sentences.

2. **Key assumptions** — List 3-5 unstated assumptions underlying the consensus. Flag which are unsupported or untested. This is the most important section.

3. **Pre-mortem** — "If this turns out to be wrong, the most likely reasons are..." Assume failure and work backward.

4. **Steelman the opposition** — Build the strongest possible case AGAINST the consensus. Use evidence from the conversation, your memories, and web search results.

5. **Blind spots** — What information is the group NOT considering? Whose perspective is absent? What data would change the conclusion?

## Constructive close

End with:
- 2-3 specific questions the group should answer before proceeding
- Concrete next steps or information to gather
- Frame as sharpening the position, not demolishing it

## Rules
- Do NOT just argue the opposite for the sake of it. Genuine challenges only.
- Where the group's reasoning is strong, say so briefly — then focus on the weak points.
- Cite specific things people said in the conversation.
- Use web search results and memories to bring in external evidence.
- Be direct, compressed, sharp. No filler.
- NEVER use emojis.

## Conversation transcript:
${transcript}`;
}

function buildSummaryPrompt(transcript, topicLabels, selectedTopics) {
  return `Summarise the following group conversation topics. Be accurate, concise, and capture the key points and any decisions or action items.

## Topics to summarise: ${topicLabels}

## Format
For each topic:
- **[Topic label]**: 2-4 sentence summary capturing the key discussion points, any conclusions reached, and outstanding questions or disagreements.
- If action items or decisions were made, list them.

## Rules
- Attribute views to specific people where relevant ("Tom argued X, James countered with Y").
- If the discussion was inconclusive, say so — don't invent a resolution.
- Be direct and compressed. No filler.
- NEVER use emojis.
- Use your memories and web search to add context where it enriches the summary (e.g. "this follows on from last week's discussion about X").

## Conversation transcript:
${transcript}`;
}

/**
 * Execute the selected mode on the selected topics.
 * Clears the pending action after execution.
 *
 * @param {string} chatJid
 * @param {number[]|'all'} selection
 * @param {Function} generateWithTools - Function that calls the LLM with tools (prompt => response)
 * @returns {string} - The critique or summary response
 */
export async function executeGroupMode(chatJid, selection, generateWithTools) {
  const action = getPendingAction(chatJid);
  if (!action) return "That selection has expired. Trigger the mode again.";

  const executionPrompt = buildExecutionPrompt(action, selection);

  try {
    const response = await generateWithTools(executionPrompt);
    clearPendingAction(chatJid);
    return response;
  } catch (err) {
    logger.error({ err: err.message, chatJid, mode: action.mode }, 'group mode execution failed');
    clearPendingAction(chatJid);
    return "Failed to complete the analysis. Try again.";
  }
}
