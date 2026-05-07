// src/overnight/improve-synthesis.ts — synthesise 5-8 final candidates via EVO 30B.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.4 step 3.
//
// Takes the groomed observation bundle and asks EVO 30B to synthesise a
// short list of final candidates suitable for Opus selection. Each candidate:
//   - carries ≥2 evidence_refs from this week's observations
//   - has a concrete scope (file paths + rough intent)
//   - carries a predicted benefit tied to a specific capability
//   - is mission-aligned (no capability-reduction proposals)
//
// No LLM calls in this module's tests — EvoChatClient is dependency-injected.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMissionRegression } from './probe-candidates.js';
import { BANNED_FILES } from './tiering.js';

// repoRoot is two levels up from this module (src/overnight/...).
const __MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__MODULE_DIR, '..', '..');

// Pull file-path-shaped tokens out of a free-form scope string.
// Matches src/foo.ts, foo/bar/baz.js, scripts/x.sh, data/y.json, etc.
// Standalone words without a slash or extension are skipped (the
// scope often mentions module concepts like 'router' that are not
// file paths).
const PATH_REGEX = /\b(?:[a-zA-Z_][\w-]*\/)+[\w.-]+\.\w{1,5}\b/g;
function extractPaths(scope: string): string[] {
  return Array.from(new Set(scope.match(PATH_REGEX) ?? []));
}
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

/**
 * Per-candidate rejection reason captured during parse. Lets the caller
 * distinguish "EVO returned nothing parseable" from "EVO returned 8 candidates
 * but all had <2 evidence_refs" — the two have very different fixes.
 */
export type SynthesisRejectionReason =
  | 'not-object'
  | 'missing-title-or-scope'
  | 'banned-scope'
  | 'hallucinated-path'
  | 'insufficient-evidence-refs'
  | 'mission-regression';

export interface SynthesisRejection {
  index: number;
  reason: SynthesisRejectionReason;
  title: string | null;
}

export interface SynthesisDiagnostics {
  /** Null if the raw response from EVO was null/empty or source was empty. */
  rawResponseBytes: number | null;
  /** Truncated raw response for debugging. Null if response was null/empty. */
  rawResponseSample: string | null;
  /** Number of items in the parsed JSON array. -1 if JSON extraction failed. */
  parsedCount: number;
  rejections: SynthesisRejection[];
  keptCount: number;
}

export interface SynthesisResult {
  candidates: FinalCandidate[];
  diagnostics: SynthesisDiagnostics;
}

const EMPTY_DIAGNOSTICS: SynthesisDiagnostics = {
  rawResponseBytes: null,
  rawResponseSample: null,
  parsedCount: 0,
  rejections: [],
  keptCount: 0,
};

const RAW_SAMPLE_MAX_CHARS = 2000;

const SYSTEM_PROMPT = `You are synthesising a short list of improvement
candidates for a WhatsApp assistant bot called Clint, based on a week of
automated observations. You output 5-8 final candidates. Each candidate MUST:

- Address a specific pattern cluster, candidate observation, or drift alert
- Cite at least TWO evidence_refs pointing to the observations it addresses
- Have a concrete "scope" naming file path(s) and intent
- Have a specific "predicted_benefit" (not hand-wavy)
- Be mission-aligned: NO simplifications that reduce capability, NO removal
  of memory retrieval, quality gates, agentic behaviour, or dream mode
- AVOID candidates whose implementation requires editing src/router.js,
  src/cortex.js, src/memory.js, src/message-handler.js, CLAUDE.md, anything
  under docs/superpowers/, or anything under data/runtime/. These are
  banned in the implement step; Claude will refuse and the run dies with
  zero commits. If the cluster is about cortex or routing, propose changes
  in surrounding modules (cortex-cache.js, evo-llm.js, trigger.js,
  router-telemetry.js, prompt.js helpers) instead.

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
 * Parse an EVO response and return candidates plus a rejection log so callers
 * can distinguish "EVO returned nothing" from "EVO returned 8 items and all
 * failed the ≥2 evidence_refs rule".
 */
export function parseSynthesisResponseWithRejections(response: string): {
  candidates: FinalCandidate[];
  rejections: SynthesisRejection[];
  parsedCount: number;
} {
  const array = extractJsonArray(response);
  if (!array) {
    return { candidates: [], rejections: [], parsedCount: -1 };
  }

  const candidates: FinalCandidate[] = [];
  const rejections: SynthesisRejection[] = [];
  let autoIdCounter = 1;

  for (let i = 0; i < array.length; i++) {
    const entry = array[i];
    if (typeof entry !== 'object' || entry === null) {
      rejections.push({ index: i, reason: 'not-object', title: null });
      continue;
    }
    const e = entry as Record<string, unknown>;
    const entryTitle = typeof e.title === 'string' ? e.title : null;

    const scope = typeof e.scope === 'string' ? e.scope : null;
    if (!entryTitle || !scope) {
      rejections.push({ index: i, reason: 'missing-title-or-scope', title: entryTitle });
      continue;
    }

    // ≥2 evidence refs required.
    const rawRefs = Array.isArray(e.evidence_refs) ? e.evidence_refs : [];
    const evidence_refs = rawRefs.filter((x): x is string => typeof x === 'string');
    if (evidence_refs.length < 2) {
      rejections.push({ index: i, reason: 'insufficient-evidence-refs', title: entryTitle });
      continue;
    }

    // Mission-alignment
    const combined = `${entryTitle} ${scope}`;
    if (isMissionRegression(combined)) {
      rejections.push({ index: i, reason: 'mission-regression', title: entryTitle });
      continue;
    }

    // Banned-files filter — candidates whose scope touches a banned file
    // cannot be safely implemented (the implement prompt tells Claude to
    // refuse). Without this filter, opus-select picks a banned-scope
    // candidate, Claude refuses, git log is empty, and the implement event
    // records "git log capture failed" instead of the real cause.
    if (BANNED_FILES.some((b) => scope.includes(b))) {
      rejections.push({ index: i, reason: 'banned-scope', title: entryTitle });
      continue;
    }

    // Hallucinated-path filter — Qwen has shipped scopes like
    // 'src/cortex/gather.ts' (does not exist; the real file is the
    // banned src/cortex.js) to dodge the banned-files guidance.
    // Reject candidates whose scope names a non-existent path.
    const paths = extractPaths(scope);
    if (paths.length > 0) {
      const missing = paths.filter((p) => !existsSync(resolve(REPO_ROOT, p)));
      if (missing.length > 0) {
        rejections.push({ index: i, reason: 'hallucinated-path', title: entryTitle });
        continue;
      }
    }

    const id = typeof e.id === 'string' && e.id.length > 0 ? e.id : `auto-${autoIdCounter++}`;
    const category = typeof e.category === 'string' ? e.category : 'uncategorised';
    const predicted_benefit = typeof e.predicted_benefit === 'string' ? e.predicted_benefit : '';

    candidates.push({
      id,
      title: entryTitle,
      category,
      scope,
      evidence_refs,
      predicted_benefit,
    });
  }

  return { candidates, rejections, parsedCount: array.length };
}

/**
 * Parse an EVO response into FinalCandidate records. Applies:
 *   - Schema validation (title, scope, ≥2 evidence_refs required)
 *   - Mission-regression filter (spec §9)
 *   - Auto-id assignment when missing
 *
 * Backward-compatible shape. Callers that want the rejection log should use
 * parseSynthesisResponseWithRejections instead.
 */
export function parseSynthesisResponse(response: string): FinalCandidate[] {
  return parseSynthesisResponseWithRejections(response).candidates;
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
 * records alongside diagnostics. Diagnostics let the caller distinguish the
 * three zero-candidate failure modes (empty source, null/empty EVO response,
 * all-rejected parse). Production wiring in improve.ts persists diagnostics
 * to data/overnight/synthesis-debug-<date>.jsonl when keptCount === 0.
 */
export async function synthesiseFinalCandidates(
  opts: SynthesiseOptions,
): Promise<SynthesisResult> {
  if (!sourceHasContent(opts.source)) {
    return { candidates: [], diagnostics: { ...EMPTY_DIAGNOSTICS } };
  }

  const userMessage = buildUserMessage(opts.source);
  const response = await opts.client.chat(SYSTEM_PROMPT, userMessage);
  if (!response) {
    return { candidates: [], diagnostics: { ...EMPTY_DIAGNOSTICS } };
  }

  const parsed = parseSynthesisResponseWithRejections(response);
  return {
    candidates: parsed.candidates,
    diagnostics: {
      rawResponseBytes: response.length,
      rawResponseSample: response.slice(0, RAW_SAMPLE_MAX_CHARS),
      parsedCount: parsed.parsedCount,
      rejections: parsed.rejections,
      keptCount: parsed.candidates.length,
    },
  };
}
