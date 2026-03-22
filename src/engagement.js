// Group engagement gate — mute system, negative signal detection, engagement classifier
import config from './config.js';
import { classifyViaEvo } from './evo-llm.js';
import { getRecentMessages } from './buffer.js';
import logger from './logger.js';

// ── Mute system ──────────────────────────────────────────────────────────────

const mutes = new Map(); // groupJid → muteExpiresAt (epoch ms)

const BOT_NAMES = /\b(clawd|clawdbot|claude)\b/i;
const MUTE_KEYWORDS = /\b(shut\s*up|be\s*quiet|go\s*quiet|stay\s*out|stop\s*talking|silence|mute|hush)\b/i;

/**
 * Returns true if the message is an explicit mute command.
 * Requires BOTH a bot name and a mute keyword.
 */
export function isMuteTrigger(text) {
  if (!text) return false;
  return BOT_NAMES.test(text) && MUTE_KEYWORDS.test(text);
}

export function activateMute(groupJid) {
  const expires = Date.now() + config.groupMuteDurationMs;
  mutes.set(groupJid, expires);
  logger.info({ groupJid, durationMs: config.groupMuteDurationMs }, 'group muted');
}

export function isMuted(groupJid) {
  const expires = mutes.get(groupJid);
  if (!expires) return false;
  if (Date.now() >= expires) {
    mutes.delete(groupJid);
    return false;
  }
  return true;
}

export function clearMute(groupJid) {
  mutes.delete(groupJid);
  logger.info({ groupJid }, 'group mute cleared');
}

// ── Negative signal detection ────────────────────────────────────────────────

const NEGATIVE_PATTERNS = {
  told_off: /\b(shut\s*up|be\s*quiet|nobody\s*asked\s*you|stay\s*out|go\s*away|not\s*now)\b/i,
  mocked:   /\b(lol|lmao|haha|rofl)\b.*\b(clawd|clawdbot|claude)\b|\b(clawd|clawdbot|claude)\b.*\b(lol|lmao|haha|rofl)\b/i,
  corrected: /\b(no\s+(clawd|clawdbot|claude)|wrong\s+(clawd|clawdbot|claude)|that'?s\s+not\s+right|you'?re\s+wrong|incorrect)\b/i,
};

/**
 * Detect negative signals directed at the bot.
 * Returns { type: string, matched: string } or null.
 */
export function detectNegativeSignal(text) {
  if (!text) return null;
  for (const [type, pattern] of Object.entries(NEGATIVE_PATTERNS)) {
    const match = text.match(pattern);
    if (match) {
      return { type, matched: match[0] };
    }
  }
  return null;
}

// ── Engagement classifier ────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You are deciding whether a WhatsApp bot called Clawd should respond to the latest message in a group chat.

Respond with exactly one word: YES or NO.

Respond YES when:
- Someone directly addresses Clawd, asks Clawd a question, or mentions Clawd by name
- Someone asks a factual question that Clawd can answer helpfully
- The conversation has stalled and Clawd can add genuine value
- Someone is struggling with something Clawd has expertise in

Respond NO when:
- Humans are talking to each other and Clawd would be interrupting
- The message is casual banter, reactions, or social chat between humans
- Someone has recently told Clawd to be quiet or mocked its responses
- The topic is personal/emotional and Clawd's input would feel intrusive
- The message is very short (ok, lol, haha, yeah, etc.) with no question`;

/**
 * Ask the EVO 0.6B classifier whether Clawd should engage in this group message.
 * Returns true (should respond) or false (stay silent).
 * On any failure, defaults to silent.
 */
export async function shouldEngage(groupJid, senderName, messageText) {
  if (!config.engagementClassifierEnabled) {
    // Classifier disabled — default to engaging (backwards compat)
    return true;
  }

  try {
    const recent = getRecentMessages(groupJid);
    const contextLines = recent.slice(-6).map((m) => {
      const name = m.isBot ? 'Clawd' : m.senderName;
      return `${name}: ${m.text || '[media]'}`;
    });

    const prompt = contextLines.length > 0
      ? `Recent conversation:\n${contextLines.join('\n')}\n\nLatest message from ${senderName}: ${messageText}`
      : `Latest message from ${senderName}: ${messageText}`;

    const result = await classifyViaEvo(prompt, CLASSIFIER_SYSTEM_PROMPT);

    if (!result) {
      logger.warn({ groupJid }, 'engagement classifier returned null — defaulting to silent');
      return false;
    }

    const engage = result.startsWith('yes');
    logger.info({ groupJid, senderName, result, engage }, 'engagement classifier');
    return engage;
  } catch (err) {
    logger.warn({ err: err.message, groupJid }, 'engagement classifier failed — defaulting to silent');
    return false;
  }
}
