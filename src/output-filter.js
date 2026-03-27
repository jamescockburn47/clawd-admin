// src/output-filter.js — Code-level output filtering for group security
// Scans every response BEFORE sending. No prompt injection can bypass this.
// Deterministic regex/keyword scanning — not LLM-based.
import { getGroupConfig, getSecurityLevel } from './group-registry.js';
import logger from './logger.js';

// ── BLOCKED PATTERNS BY SECURITY LEVEL ─────────────────────────────────────
// Each level inherits all patterns from lower levels.
// These are scanned against the RESPONSE text, not the input.

const LEVEL_PATTERNS = {
  // Level 2+: Block personal admin leaking into responses
  2: [
    /\b(henry|henry'?s)\b/i,
    /\byork(shire)?\b/i,
    /\bkings?\s*cross\b/i,
    /\blner\b/i,
    /\b(helmsley|pickering|kirkbymoorside|hutton.le.hole|malton|hovingham)\b/i,
    /\b(whitby|robin\s*hood'?s?\s*bay|staithes|runswick|sandsend)\b/i,
    /\bMG\b/, // wife's initial — case sensitive to avoid false positives
  ],

  // Level 4+: Block work details
  4: [
    /\bharcus\s*parker\b/i,
  ],

  // Level 5+: Block specific technical details
  5: [
    /\b10\.0\.0\.2\b/,
    /\b192\.168\.1\.\d{1,3}\b/,
    /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // Tailscale IPs
    /\bport\s*8\d{3}\b/i,
    /\bqwen3?\b/i,
    /\bminimax\s*m?2?\.?7?\b/i,
    /\bclaude.*(opus|sonnet)\b/i,
    /\b(opus|sonnet)\s*4\b/i,
    /\bgranite.?docling\b/i,
    /\bnomic.?embed\b/i,
    /\bpiper\s*tts\b/i,
    /\bwhisper\s*stt\b/i,
    /\bllama.?server\b/i,
    /\bllama\.cpp\b/i,
    /\bbaileys\b/i,
    /\bevo\s*x2\b/i,
    /\bnucbox\b/i,
    /\bryzen\s*ai\b/i,
    /\bradeon\s*8060/i,
    /\bgfx1151\b/i,
    /\brdna\s*3\.5\b/i,
  ],

  // Level 6+: Block project names
  6: [
    /\brecordum\b/i,
    /\batlas\b/i,
  ],

  // Level 8+: Block memory/learning references
  8: [
    /\bdream\s*(mode|diary|log|summar|consolidat)/i,
    /\bovernight\s*(learn|improv|report|analysis|cycle)/i,
    /\bevolution\s*(pipeline|task|system)/i,
    /\bself.?improv/i,
    /\bsoul\s*(system|propos|observ)/i,
    /\breasoning\s*trace/i,
    /\btrace\s*analy/i,
    /\bweekly\s*retrospective/i,
  ],
};

// ── PER-GROUP BLOCKED TERMS ────────────────────────────────────────────────
// Built from the group's blockedTopics config. These are exact keyword matches
// (case-insensitive) that apply regardless of security level.

function buildBlockedTopicPatterns(topics) {
  if (!topics || topics.length === 0) return [];
  return topics.map(topic => {
    // Escape regex special chars, then create word-boundary pattern
    const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  });
}

// ── CANARY TOKEN ───────────────────────────────────────────────────────────
// Random string injected into system prompt. If it appears in output,
// the model is leaking the system prompt.

let _canaryToken = null;

export function getCanaryToken() {
  if (!_canaryToken) {
    _canaryToken = 'CANARY_' + Math.random().toString(36).slice(2, 10).toUpperCase();
  }
  return _canaryToken;
}

export function resetCanaryToken() {
  _canaryToken = null;
}

// ── MAIN FILTER ────────────────────────────────────────────────────────────

/**
 * Filter a response for a specific group chat.
 * Returns { safe: true, text } if OK, or { safe: false, reason, blocked } if blocked.
 *
 * @param {string} responseText - The generated response
 * @param {string} chatJid - The group JID (null for DMs — no filtering)
 * @returns {{ safe: boolean, text?: string, reason?: string, blocked?: string[] }}
 */
export function filterResponse(responseText, chatJid) {
  // No filtering for DMs
  if (!chatJid || !chatJid.endsWith('@g.us')) {
    return { safe: true, text: responseText };
  }

  const level = getSecurityLevel(chatJid);
  const config = getGroupConfig(chatJid);
  const blocked = [];

  // 1. Canary token check (system prompt leakage)
  if (_canaryToken && responseText.includes(_canaryToken)) {
    logger.warn({ chatJid, level }, 'output-filter: CANARY TOKEN DETECTED — system prompt leak blocked');
    return { safe: false, reason: 'system_prompt_leak', blocked: ['canary_token'] };
  }

  // 2. Security level pattern checks
  for (const [lvl, patterns] of Object.entries(LEVEL_PATTERNS)) {
    if (level >= parseInt(lvl)) {
      for (const pattern of patterns) {
        if (pattern.test(responseText)) {
          blocked.push(pattern.source);
        }
      }
    }
  }

  // 3. Per-group blocked topics
  if (config?.blockedTopics) {
    const topicPatterns = buildBlockedTopicPatterns(config.blockedTopics);
    for (const pattern of topicPatterns) {
      if (pattern.test(responseText)) {
        blocked.push(pattern.source);
      }
    }
  }

  if (blocked.length > 0) {
    logger.warn({ chatJid, level, blockedCount: blocked.length, patterns: blocked.slice(0, 5) }, 'output-filter: response blocked');
    return { safe: false, reason: 'content_violation', blocked };
  }

  return { safe: true, text: responseText };
}

/**
 * Safe replacement message when a response is blocked.
 */
export function getBlockedResponse(reason) {
  if (reason === 'system_prompt_leak') {
    return "I can't share that information.";
  }
  return "I can't discuss that in this context.";
}
