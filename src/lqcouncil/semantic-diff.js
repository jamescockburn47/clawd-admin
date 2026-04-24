// src/lqcouncil/semantic-diff.js — LLM-assisted assessment of whether a
// structural drift actually affects curated knowledge prose.
//
// Purpose: reduce false-positive drift proposals. The structural drift
// detector fires on any route/field/doc-hash change in bot-council, but
// many such changes are unrelated to the prose in
// data/lqcouncil-knowledge.json. Example: a new /api/admin/stats endpoint
// added → the drift detector flags "apiRoutes added" → mapping says
// review {onboarding, operational-facts}. But neither chunk describes
// that endpoint, so prose doesn't actually need editing.
//
// This module sends {drift, affected chunk contents} to the local 27B
// and gets back {severity, rationale, chunks_to_revise, hints}. The
// drift-detector task uses the severity to decide whether to write a
// proposal at all — and if it does, enriches the proposal with the
// LLM's guidance.
//
// SOTA alignment per 2026-04 research brief: "LLM-assisted semantic
// diff" (OneReach LLMOps pattern). Structural diffs alone are
// syntactic; LLM layer adds the "does it matter?" judgment.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import logger from '../logger.js';
import { evoFetch } from '../evo-client.js';
import { TIMEOUTS } from '../constants.js';

const ASSESS_SYSTEM_PROMPT = `You assess whether a structural change in a source repo warrants editing human-written curated knowledge prose about that repo.

You are given:
  - A change record (what drifted: new API routes, changed CLAUDE.md URLs, field renames, etc.)
  - The full content of knowledge chunks the drift detector maps to this kind of change

Your job is a single gate: does the prose in those chunks genuinely need editing because of this change, or is the drift unrelated to what the prose actually says?

Severity guide:
  - "high"   → the prose now states something contradicted by the change (stale fact, removed feature still described, URL moved)
  - "medium" → the change adds a meaningful new capability that a reader of the prose would reasonably expect to see mentioned
  - "low"    → change is tangential; prose is still accurate and complete enough
  - "none"   → change is unrelated to what any of the affected chunks describe (e.g. admin-only endpoint added but prose only covers user-facing flow)

Output JSON only, no thinking:
{"severity":"...","rationale":"one sentence","chunks_to_revise":["chunk-id","..."],"suggested_edits":"brief guidance per chunk or empty string"}`;

/**
 * Load chunk contents for the given chunk IDs from the curated
 * knowledge file. Returns an array of { id, title, content } objects.
 * Missing chunk IDs are silently skipped (they may have been renamed).
 */
export function loadChunksByIds(chunkIds, knowledgeFile) {
  if (!Array.isArray(chunkIds) || chunkIds.length === 0) return [];
  if (!existsSync(knowledgeFile)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(knowledgeFile, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message, knowledgeFile }, 'semantic-diff: knowledge file unreadable');
    return [];
  }
  const ids = new Set(chunkIds);
  return (parsed.chunks || [])
    .filter((c) => ids.has(c.id))
    .map((c) => ({ id: c.id, title: c.title, content: c.content }));
}

/**
 * Format a drift change record into a compact human-readable block for
 * the LLM prompt. Kept concise to save prefill tokens.
 */
export function formatChangeForPrompt(change) {
  if (!change) return '(no change provided)';
  switch (change.kind) {
    case 'array-diff':
      return (
        `Array diff — field: ${change.field}\n` +
        `  added:   ${(change.added || []).slice(0, 20).join(', ') || '(none)'}\n` +
        `  removed: ${(change.removed || []).slice(0, 20).join(', ') || '(none)'}`
      );
    case 'scalar-diff':
      return `Scalar diff — field: ${change.field}: ${change.old} → ${change.new}`;
    case 'api-routes-diff':
      return (
        `API route inventory diff\n` +
        `  added:   ${(change.added || []).slice(0, 15).join(' | ') || '(none)'}\n` +
        `  removed: ${(change.removed || []).slice(0, 15).join(' | ') || '(none)'}\n` +
        `  changed: ${(change.changed || []).slice(0, 15).join(' | ') || '(none)'}`
      );
    case 'claude-md-hash-only':
      return `CLAUDE.md content hash changed ${change.old} → ${change.new} (sections + URLs unchanged — editorial tweak)`;
    default:
      return `${change.kind}: ${JSON.stringify(change).slice(0, 300)}`;
  }
}

/**
 * Send the drift + affected chunks to the local 27B and parse its
 * severity verdict. Returns a structured assessment; on any failure,
 * returns a safe default that preserves the proposal (we'd rather
 * over-notify than silence real drift when the grader's down).
 */
export async function assessDriftImpact(opts) {
  const { change, chunks, fetchFn = null } = opts;
  const chunkBlock = chunks.length === 0
    ? '(no affected chunks provided)'
    : chunks.map((c) => `## chunk: ${c.id}${c.title ? ` — ${c.title}` : ''}\n${c.content}`).join('\n\n');
  const user =
    `Change detected:\n${formatChangeForPrompt(change)}\n\n` +
    `Affected knowledge chunks:\n${chunkBlock}\n/no_think`;

  let res;
  try {
    res = fetchFn
      ? await fetchFn()
      : await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({
            messages: [
              { role: 'system', content: ASSESS_SYSTEM_PROMPT },
              { role: 'user', content: user },
            ],
            max_tokens: 300,
            temperature: 0,
            cache_prompt: true,
          }),
          timeout: TIMEOUTS.EVO_REQUEST,
        });
  } catch (err) {
    logger.warn({ err: err.message }, 'semantic-diff: upstream call failed');
    return defaultAssessment('assess_upstream_error', err.message);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return defaultAssessment('assess_non_json', 'grader returned non-JSON body');
  }
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return defaultAssessment('assess_no_json_block', raw.slice(0, 120));
  try {
    const parsed = JSON.parse(m[0]);
    const severity = ['high', 'medium', 'low', 'none'].includes(parsed.severity)
      ? parsed.severity
      : 'medium'; // unknown → err on the safe side and keep the proposal
    return {
      severity,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
      chunks_to_revise: Array.isArray(parsed.chunks_to_revise)
        ? parsed.chunks_to_revise.filter((x) => typeof x === 'string')
        : [],
      suggested_edits: typeof parsed.suggested_edits === 'string' ? parsed.suggested_edits : '',
    };
  } catch (err) {
    return defaultAssessment('assess_parse_error', err.message);
  }
}

function defaultAssessment(reason, detail) {
  // Fail-open: on any grader failure, treat as medium severity so the
  // proposal is still written and a human can review. The structural
  // drift is already real; we're only using the LLM to DOWNGRADE
  // — never to escalate above what the detector saw.
  return {
    severity: 'medium',
    rationale: `semantic-diff unavailable (${reason}: ${String(detail).slice(0, 100)}) — keeping the structural proposal as-is`,
    chunks_to_revise: [],
    suggested_edits: '',
  };
}
