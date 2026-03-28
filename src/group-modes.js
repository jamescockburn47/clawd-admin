// src/group-modes.js — Devil's Advocate and Summary mode execution
// These are special group response modes triggered by "@clawd devil's advocate"
// or "@clawd summarise". Both use a two-step flow: topic segmentation → execution.
import { getRecentGroupMessages, formatTranscript, buildSegmentationPrompt, parseTopicList, formatTopicSelection } from './topic-scan.js';
import { setPendingAction, getPendingAction, clearPendingAction, parseTopicSelection } from './pending-action.js';
import logger from './logger.js';

// ── TRIGGER DETECTION ────────────────────────────────────────────────────────

const DEVILS_ADVOCATE_PATTERN = /\bdevil'?s?\s*advocate\b/i;
const SUMMARY_PATTERN = /\b(summari[sz]e|summary|recap|catch me up|what did i miss|what have i missed)\b/i;

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

  const selection = parseTopicSelection(text, action.topics.length);
  if (!selection) return null;

  return { action, selectedTopics: selection };
}

// ── STEP 1: TOPIC SEGMENTATION ──────────────────────────────────────────────

/**
 * Run topic segmentation on recent group messages.
 * Sends the segmentation prompt to the LLM and stores the pending action.
 *
 * @param {string} chatJid - Group JID
 * @param {string} mode - 'critique' or 'summary'
 * @param {Function} generateResponse - LLM call function (text => response)
 * @returns {string} - WhatsApp message with numbered topic list
 */
export async function runTopicSegmentation(chatJid, mode, generateResponse) {
  const messages = getRecentGroupMessages(chatJid, 50);

  if (messages.length < 3) {
    return "Not enough recent conversation to analyse. I need at least a few messages.";
  }

  // Filter out bot messages for cleaner topic extraction
  const humanMessages = messages.filter(m => !m.isBot);
  if (humanMessages.length < 2) {
    return "Not enough discussion to segment into topics.";
  }

  const transcript = formatTranscript(messages);
  const segPrompt = buildSegmentationPrompt(transcript);

  try {
    const segResponse = await generateResponse(segPrompt);
    const topics = parseTopicList(segResponse);

    if (topics.length === 0) {
      return "I couldn't identify distinct topics in the recent conversation. Try being more specific about what you'd like me to analyse.";
    }

    // If only one topic, skip selection and go straight to execution
    if (topics.length === 1) {
      setPendingAction(chatJid, mode, topics, transcript);
      const modeLabel = mode === 'critique' ? 'critique' : 'summarise';
      return `I can see one topic: *${topics[0].label}*${topics[0].summary ? ` — ${topics[0].summary}` : ''}.\n\nShall I ${modeLabel} it? Reply "yes" or "1".`;
    }

    // Store for step 2
    setPendingAction(chatJid, mode, topics, transcript);
    return formatTopicSelection(topics, mode);
  } catch (err) {
    logger.error({ err: err.message, chatJid, mode }, 'topic segmentation failed');
    return "Failed to analyse the conversation. Try again in a moment.";
  }
}

// ── STEP 2: MODE EXECUTION ──────────────────────────────────────────────────

/**
 * Build the execution prompt for selected topics.
 *
 * @param {PendingAction} action - The pending action with transcript and topics
 * @param {number[]|'all'} selection - Selected topic numbers or 'all'
 * @returns {string} - System prompt for the execution LLM call
 */
export function buildExecutionPrompt(action, selection) {
  const selectedTopics = selection === 'all'
    ? action.topics
    : action.topics.filter(t => selection.includes(t.number));

  const topicLabels = selectedTopics.map(t => t.label).join(', ');

  if (action.mode === 'critique') {
    return buildCritiquePrompt(action.transcript, topicLabels, selectedTopics);
  }
  return buildSummaryPrompt(action.transcript, topicLabels, selectedTopics);
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
