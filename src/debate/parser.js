// src/debate/parser.js — lenient JSON extraction from debate model output.
// MiniMax M2.7 (primary debate model) often wraps JSON in <think> tags,
// markdown fences, or prose preamble despite instructions; this salvages
// the structured payload instead of discarding an otherwise-good response.

import logger from '../logger.js';

/**
 * Scan text for `{"response"` openings and count braces to find the
 * matching close. Handles multiple candidates and string-escape tracking.
 */
function extractEmbeddedJson(text) {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf('{"response"', searchFrom);
    if (idx === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = idx; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"' && !escape) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(idx, i + 1));
          if (typeof parsed.response === 'string') return parsed;
        } catch { /* try next occurrence */ }
        break;
      }
    }
    searchFrom = idx + 1;
  }
  return null;
}

/**
 * Parse a debate model's response. Strategy:
 *   1. Strip `<think>` tags and markdown fences.
 *   2. Try direct JSON.parse.
 *   3. Scan for embedded `{"response": ...}` inside prose.
 *   4. Last resort: wrap raw text and fill required round-specific fields.
 */
export function parseModelResponse(text, round) {
  let cleaned = text.trim();

  if (cleaned.startsWith('<think>')) {
    const end = cleaned.indexOf('</think>');
    if (end !== -1) cleaned = cleaned.slice(end + 8).trim();
  }

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.response === 'string') return parsed;
  } catch { /* fall through */ }

  const extracted = extractEmbeddedJson(cleaned);
  if (extracted) {
    logger.info('debate: extracted embedded JSON from model output');
    return extracted;
  }

  logger.warn('debate: no JSON found in model output, wrapping as plain text');
  const result = { response: cleaned };
  if (round >= 1) result.confidence = 50;
  if (round === 2) {
    result.challenge = {
      claim_targeted: 'Unable to extract specific claim',
      counter_evidence: 'Response was unstructured',
      type: 'logical',
    };
  }
  if (round === 4) {
    result.position_change = {
      changed: false,
      from_summary: 'Position maintained',
      to_summary: 'Position maintained',
      reason: 'Response was unstructured; defaulting to no change',
    };
  }
  return result;
}
