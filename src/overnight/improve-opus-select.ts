// src/overnight/improve-opus-select.ts — Opus candidate selection (spec §4.4 step 4).
//
// One Opus session per deep night. Takes the synthesised candidate list,
// asks Opus to pick the ONE with highest mission value and lowest regression
// risk, defend the choice against the strongest objection, and refuse to
// pick any candidate that reduces agentic capability in exchange for a
// performance metric — returning NULL instead.
//
// Budget-tracked: the caller is expected to increment Opus session counters
// on the BudgetTracker before invocation.

import { isMissionRegression } from './probe-candidates.js';
import type { FinalCandidate } from './improve-synthesis.js';

export interface OpusClient {
  /**
   * Run one Opus session with the given system prompt and user message.
   * Returns the raw response text or null on budget/availability failure.
   */
  callOpus(systemPrompt: string, userMessage: string): Promise<string | null>;
}

export interface SelectCandidateOptions {
  client: OpusClient;
  candidates: FinalCandidate[];
}

export interface Selection {
  selected_id: string | null;
  rationale: string;
  objections_considered: string;
  null_reason?: string;
}

const SYSTEM_PROMPT = `You are selecting ONE improvement candidate for a
WhatsApp assistant bot called Clint. You have a strict mission clause: the
bot MUST get better at agentic reasoning, memory use, and legal analysis.
It is NOT allowed to become simpler, faster, or cheaper at the COST of
capability. Any candidate that proposes reducing memory retrieval, skipping
quality gates, removing dream mode, or trading capability for a metric
MUST be refused in favour of NULL.

Procedure:
1. Read all candidates.
2. For each candidate, identify the strongest objection to it (what could go
   wrong, who would notice, what capability would degrade).
3. Pick the ONE candidate with highest mission value and lowest regression
   risk, OR return NULL if no candidate meets the bar.
4. Defend your choice by addressing the strongest objection in one sentence.

Output STRICT JSON:
{
  "selected_id": "<candidate id>" or null,
  "rationale": "one sentence explaining why this candidate wins",
  "objections_considered": "one sentence summarising the strongest objection and how it's mitigated",
  "null_reason": "if selected_id is null, one sentence explaining why no candidate was acceptable"
}

Return ONLY the JSON object. No markdown, no prose, no thinking.`;

function buildUserMessage(candidates: FinalCandidate[]): string {
  const parts: string[] = ['=== CANDIDATES ==='];
  for (const c of candidates) {
    parts.push(`[${c.id}] ${c.title}`);
    parts.push(`  category: ${c.category}`);
    parts.push(`  scope:    ${c.scope}`);
    parts.push(`  benefit:  ${c.predicted_benefit}`);
    parts.push(`  evidence: ${c.evidence_refs.join(', ')}`);
    parts.push('');
  }
  return parts.join('\n');
}

function extractJsonObject(response: string): Record<string, unknown> | null {
  let text = response.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) text = fenceMatch[1]!;
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse a raw Opus response into a Selection. Defensively handles missing
 * fields and the NULL-selection case.
 */
export function parseSelectionResponse(
  response: string,
  candidates: FinalCandidate[],
): Selection {
  const obj = extractJsonObject(response);
  if (!obj) {
    return {
      selected_id: null,
      rationale: '',
      objections_considered: '',
      null_reason: 'could not parse Opus response',
    };
  }

  let selected_id: string | null = null;
  if (typeof obj.selected_id === 'string' && obj.selected_id.length > 0) {
    // Verify the ID matches one of the input candidates — Opus can hallucinate IDs
    const match = candidates.find((c) => c.id === obj.selected_id);
    if (match) {
      selected_id = match.id;
      // Defensive: re-check mission regression on the selected candidate.
      // Opus shouldn't select these, but the synthesis step's filter may
      // have been bypassed or Opus may be experimenting.
      if (isMissionRegression(`${match.title} ${match.scope}`)) {
        return {
          selected_id: null,
          rationale: '',
          objections_considered: '',
          null_reason: `selected candidate ${match.id} tripped the mission-regression filter`,
        };
      }
    }
  }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  const objections_considered =
    typeof obj.objections_considered === 'string' ? obj.objections_considered : '';
  const null_reason = typeof obj.null_reason === 'string' ? obj.null_reason : undefined;

  return { selected_id, rationale, objections_considered, null_reason };
}

/**
 * Call Opus once to select a candidate. Returns Selection with
 * selected_id === null if no candidate was chosen (or an error occurred).
 * The caller is responsible for incrementing the Opus session counter.
 */
export async function selectCandidate(
  opts: SelectCandidateOptions,
): Promise<Selection> {
  if (opts.candidates.length === 0) {
    return {
      selected_id: null,
      rationale: '',
      objections_considered: '',
      null_reason: 'no candidates to select from',
    };
  }

  const userMessage = buildUserMessage(opts.candidates);
  const response = await opts.client.callOpus(SYSTEM_PROMPT, userMessage);
  if (!response) {
    return {
      selected_id: null,
      rationale: '',
      objections_considered: '',
      null_reason: 'Opus call returned null (budget exceeded or transient error)',
    };
  }

  return parseSelectionResponse(response, opts.candidates);
}
