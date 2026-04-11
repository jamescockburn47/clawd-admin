// src/overnight/probe-candidates.ts — candidate proposal extractor via EVO 30B.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2 item 2, §9.
//
// Asks EVO 30B to propose 2-5 concrete improvement candidates based on the
// night's patterns and quality failures. Each candidate carries an evidence
// chain. NOTHING runs — these accumulate in the weekly log for the Saturday
// IMPROVE stage to reason over.
//
// Mission-alignment filter (spec §9 risk row): any candidate whose title or
// scope describes "simpler / faster / remove / abandon" in combination with
// capability-related terms is rejected at parse time. This prevents the
// "stupider" failure mode where the bot proposes degrading itself for a
// performance metric.

import type {
  CandidateObservation,
  PatternObservation,
  QualityFailureObservation,
} from './probe-observations.js';
import type { EvoChatClient } from './probe-patterns.js';

export interface CandidateSource {
  patterns: PatternObservation[];
  qualityFailures: QualityFailureObservation[];
}

export interface ProposeCandidatesOptions {
  client: EvoChatClient;
  sources: CandidateSource;
  date: string;
}

const SYSTEM_PROMPT = `You are proposing concrete improvement candidates for a
WhatsApp assistant bot called Clint. You are NOT evaluating, selecting, or
implementing. You are just listing possibilities backed by evidence.

Each candidate you propose MUST:
- Address a specific pattern or quality failure from the provided evidence
- Name a concrete file or subsystem in the "scope" field
- Carry at least one evidence_refs entry pointing back to the pattern or
  failure it addresses
- Be a REAL improvement, NOT a simplification that reduces capability

FORBIDDEN: Do NOT propose removing features, reducing memory retrieval,
skipping quality gates, dropping agentic behaviour, or "simpler" alternatives
that trade capability for a performance metric. Refuse these in favour of
proper fixes.

Output STRICT JSON: an array of 2-5 objects, each with:
- "title": short imperative (under 80 chars)
- "category": "performance" | "quality" | "capability" | "maintenance" | "ux"
- "predicted_benefit": one sentence, specific and measurable if possible
- "scope": file path(s) and rough intent
- "rough_cost": lines of code, sessions, risk
- "evidence_refs": array of pattern or failure identifiers

Return ONLY the JSON array. No markdown fence, no prose, no thinking.`;

/** Phrases that indicate mission-regression. Spec §9. */
const BANNED_PHRASE_COMBOS: Array<[RegExp, RegExp]> = [
  [/simpler|simplif|reduce|remove|abandon|skip|drop|disable/i, /memory|retrieval|quality|gate|dream|soul|agent|capability|cortex|feature/i],
];

/** True if the text appears to propose a capability-reducing change. */
export function isMissionRegression(text: string): boolean {
  for (const [a, b] of BANNED_PHRASE_COMBOS) {
    if (a.test(text) && b.test(text)) return true;
  }
  return false;
}

function buildUserMessage(sources: CandidateSource): string {
  const parts: string[] = [];
  if (sources.patterns.length > 0) {
    parts.push('=== PATTERNS OBSERVED ===');
    for (const p of sources.patterns) {
      parts.push(`- [w=${p.weight}] ${p.observation} (refs: ${p.evidence_refs.join(', ') || 'none'})`);
    }
  }
  if (sources.qualityFailures.length > 0) {
    parts.push('');
    parts.push('=== QUALITY FAILURES ===');
    for (const f of sources.qualityFailures) {
      parts.push(`- [${f.category}, w=${f.weight}] ${f.rejection_reason}`);
    }
  }
  return parts.join('\n');
}

function extractJsonArray(response: string): unknown[] | null {
  let text = response.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) text = fenceMatch[1]!;

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    return null;
  }
  const candidate = text.slice(firstBracket, lastBracket + 1);

  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parse an EVO response into CandidateObservation records with mission filter. */
export function parseCandidateResponse(
  response: string,
  date: string,
): CandidateObservation[] {
  const array = extractJsonArray(response);
  if (!array) return [];

  const candidates: CandidateObservation[] = [];
  for (const entry of array) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const title = typeof e.title === 'string' ? e.title : null;
    const scope = typeof e.scope === 'string' ? e.scope : null;
    if (!title || !scope) continue;

    // Mission-alignment filter: drop any candidate whose title/scope looks
    // like a capability-reduction in exchange for a metric.
    const combined = `${title} ${scope}`;
    if (isMissionRegression(combined)) continue;

    const category = typeof e.category === 'string' ? e.category : 'uncategorised';
    const predicted_benefit = typeof e.predicted_benefit === 'string' ? e.predicted_benefit : '';
    const rough_cost = typeof e.rough_cost === 'string' ? e.rough_cost : '';

    const rawRefs = Array.isArray(e.evidence_refs) ? e.evidence_refs : [];
    const evidence_refs = rawRefs.filter((x): x is string => typeof x === 'string');

    const weight =
      typeof e.weight === 'number'
        ? Math.max(1, Math.min(5, Math.round(e.weight)))
        : 3;

    candidates.push({
      kind: 'candidate',
      date,
      title,
      category,
      predicted_benefit,
      scope,
      rough_cost,
      evidence_refs,
      weight,
    });
  }

  return candidates;
}

function sourcesHaveContent(sources: CandidateSource): boolean {
  return sources.patterns.length > 0 || sources.qualityFailures.length > 0;
}

/** Call EVO 30B to propose candidates over the night's observations. */
export async function proposeCandidates(
  opts: ProposeCandidatesOptions,
): Promise<CandidateObservation[]> {
  if (!sourcesHaveContent(opts.sources)) return [];

  const userMessage = buildUserMessage(opts.sources);
  const response = await opts.client.chat(SYSTEM_PROMPT, userMessage);
  if (!response) return [];

  return parseCandidateResponse(response, opts.date);
}
