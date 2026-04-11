// src/overnight/improve-synthesis.ts — synthesise 5-8 final candidates via EVO 30B.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.4 step 3.
//
// Takes the groomed observation bundle and asks EVO 30B to synthesise a
// short list of final candidates suitable for Opus selection. Each candidate:
//   - carries ≥2 evidence_refs from this week's observations (ATLAS invariant)
//   - has a concrete scope (file paths + rough intent)
//   - carries a predicted benefit tied to a specific capability
//   - is mission-aligned (no capability-reduction proposals)
//
// No LLM calls in this module's tests — EvoChatClient is dependency-injected.

import { isMissionRegression } from './probe-candidates.js';
import type { EvoChatClient } from './probe-patterns.js';
import type {
  CandidateObservation,
  DriftObservation,
} from './probe-observations.js';
import type { PatternCluster } from './improve-grooming.js';

export interface SynthesisSource {
  candidates: CandidateObservation[];
  patternClusters: PatternCluster[];
  worseDriftAlerts: DriftObservation[];
}

export interface SynthesiseOptions {
  client: EvoChatClient;
  source: SynthesisSource;
}

export interface FinalCandidate {
  id: string;
  title: string;
  category: string;
  scope: string;
  evidence_refs: string[];
  predicted_benefit: string;
}

const SYSTEM_PROMPT = `You are synthesising a short list of improvement
candidates for a WhatsApp assistant bot called Clint, based on a week of
automated observations. You output 5-8 final candidates. Each candidate MUST:

- Address a specific pattern cluster, candidate observation, or drift alert
- Cite at least TWO evidence_refs pointing to the observations it addresses
- Have a concrete "scope" naming file path(s) and intent
- Have a specific "predicted_benefit" (not hand-wavy)
- Be mission-aligned: NO simplifications that reduce capability, NO removal
  of memory retrieval, quality gates, agentic behaviour, or dream mode

If worse-drift alerts are present, at least one of your candidates MUST
address them directly (they indicate silent regressions).

Output STRICT JSON: an array of 5-8 objects with fields:
{
  "id": "c1"..."c8",
  "title": short imperative (under 80 chars),
  "category": "performance" | "quality" | "capability" | "maintenance" | "ux",
  "scope": "file paths and intent",
  "evidence_refs": ["ref1", "ref2", ...],
  "predicted_benefit": "specific, measurable if possible"
}

Return ONLY the JSON array. No markdown, no prose.`;

function buildUserMessage(source: SynthesisSource): string {
  const parts: string[] = [];

  if (source.worseDriftAlerts.length > 0) {
    parts.push('=== WORSE DRIFT ALERTS (HIGH PRIORITY) ===');
    for (const d of source.worseDriftAlerts) {
      parts.push(`- [${d.input_hash}] ${d.reason} (diff: ${d.diff_summary})`);
    }
    parts.push('');
  }

  if (source.patternClusters.length > 0) {
    parts.push('=== PATTERN CLUSTERS ===');
    for (const cluster of source.patternClusters) {
      parts.push(`Cluster "${cluster.keyword}" (weight ${cluster.totalWeight}):`);
      for (const p of cluster.patterns) {
        parts.push(`  - ${p.observation}`);
      }
    }
    parts.push('');
  }

  if (source.candidates.length > 0) {
    parts.push('=== CANDIDATE OBSERVATIONS (nightly proposals) ===');
    for (const c of source.candidates) {
      parts.push(`[w=${c.weight}] ${c.title}`);
      parts.push(`  scope: ${c.scope}`);
      parts.push(`  benefit: ${c.predicted_benefit}`);
      parts.push(`  refs: ${c.evidence_refs.join(', ')}`);
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
  if (firstBracket === -1 || lastBracket === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse an EVO response into FinalCandidate records. Applies:
 *   - Schema validation (title, scope, ≥2 evidence_refs required)
 *   - Mission-regression filter (spec §9)
 *   - Auto-id assignment when missing
 */
export function parseSynthesisResponse(response: string): FinalCandidate[] {
  const array = extractJsonArray(response);
  if (!array) return [];

  const candidates: FinalCandidate[] = [];
  let autoIdCounter = 1;

  for (const entry of array) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;

    const title = typeof e.title === 'string' ? e.title : null;
    const scope = typeof e.scope === 'string' ? e.scope : null;
    if (!title || !scope) continue;

    // ≥2 evidence refs required (ATLAS invariant strict form)
    const rawRefs = Array.isArray(e.evidence_refs) ? e.evidence_refs : [];
    const evidence_refs = rawRefs.filter((x): x is string => typeof x === 'string');
    if (evidence_refs.length < 2) continue;

    // Mission-alignment
    const combined = `${title} ${scope}`;
    if (isMissionRegression(combined)) continue;

    const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : `auto-${autoIdCounter++}`;
    const category = typeof e.category === 'string' ? e.category : 'uncategorised';
    const predicted_benefit = typeof e.predicted_benefit === 'string' ? e.predicted_benefit : '';

    candidates.push({
      id,
      title,
      category,
      scope,
      evidence_refs,
      predicted_benefit,
    });
  }

  return candidates;
}

function sourceHasContent(source: SynthesisSource): boolean {
  return (
    source.candidates.length > 0 ||
    source.patternClusters.length > 0 ||
    source.worseDriftAlerts.length > 0
  );
}

/**
 * Call EVO 30B with the synthesis prompt and return parsed FinalCandidate
 * records. Returns an empty array if the source is empty, the LLM returns
 * null, or parsing produces zero valid candidates.
 */
export async function synthesiseFinalCandidates(
  opts: SynthesiseOptions,
): Promise<FinalCandidate[]> {
  if (!sourceHasContent(opts.source)) return [];

  const userMessage = buildUserMessage(opts.source);
  const response = await opts.client.chat(SYSTEM_PROMPT, userMessage);
  if (!response) return [];

  return parseSynthesisResponse(response);
}
