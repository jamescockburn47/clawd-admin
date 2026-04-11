// src/overnight/probe-patterns.ts — pattern observation extractor using EVO 30B.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2 item 1.
//
// Asks EVO 30B to scan yesterday's trace samples + quality anomalies and
// surface recurring patterns worth closer inspection. Returns structured
// PatternObservation entries. Zero actions taken — just observation.
//
// The extractor is dependency-injected (EvoChatClient) so tests can stub
// without spinning up an LLM. Production wiring in probe.ts passes a
// thin wrapper around evoSimpleChat() from ../evo-llm.js.

import type { PatternObservation } from './probe-observations.js';

/** Minimal chat client contract — mirrors evoSimpleChat's signature. */
export interface EvoChatClient {
  chat(systemPrompt: string, userMessage: string): Promise<string | null>;
}

/** Input data the extractor reasons over. */
export interface TraceSource {
  /** Parsed trace-analysis.json from today, or null if unavailable. */
  traceAnalysis: Record<string, unknown> | null;
  /** Compact one-line summaries of recent traces (input|category|tools|latency). */
  recentTraceSamples: string[];
}

export interface ExtractPatternsOptions {
  client: EvoChatClient;
  sources: TraceSource;
  date: string;
}

const SYSTEM_PROMPT = `You are a silent observer of a bot's behaviour.
Your job is to identify recurring patterns in overnight telemetry that
a human reviewer should examine. You do NOT suggest fixes, propose
changes, or evaluate quality. You only surface observations.

Output STRICT JSON: an array of objects, each with:
- "observation": one sentence describing the pattern (plain English)
- "weight": integer 1-5 (5 = strong signal, 1 = weak)
- "evidence_refs": array of trace IDs or identifiers supporting the observation

Output 2-5 observations maximum. Return ONLY the JSON array, nothing else.
Do not include markdown, explanation, or thinking.`;

function buildUserMessage(sources: TraceSource): string {
  const parts: string[] = [];

  if (sources.traceAnalysis) {
    const ta = sources.traceAnalysis as Record<string, unknown>;
    parts.push('=== TRACE ANALYSIS ===');
    parts.push(`Total traces analysed: ${ta.totalTraces ?? 'unknown'}`);
    if (Array.isArray(ta.anomalies)) {
      parts.push(`Anomalies detected: ${ta.anomalies.length}`);
      for (const a of ta.anomalies as Array<Record<string, unknown>>) {
        parts.push(`- [${a.severity ?? 'info'}] ${a.type ?? ''}: ${a.detail ?? ''}`);
      }
    }
    if (ta.categories && typeof ta.categories === 'object') {
      const cats = Object.entries(ta.categories as Record<string, number>)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      parts.push(`Category distribution: ${cats}`);
    }
    if (ta.agency && typeof ta.agency === 'object') {
      const agency = ta.agency as Record<string, unknown>;
      parts.push('=== AMBIENT AGENCY ===');
      parts.push(
        `Decisions=${agency.totalDecisions ?? 0} sent=${agency.sent ?? 0} silent=${agency.silent ?? 0} sentRate=${agency.sentRate ?? 0}%`,
      );
      if (agency.feedback && typeof agency.feedback === 'object') {
        const feedback = agency.feedback as Record<string, number>;
        parts.push(
          `Feedback: positive=${feedback.positive ?? 0} negative=${feedback.negative ?? 0} neutral=${feedback.neutral ?? 0} corrections=${feedback.corrections ?? 0}`,
        );
      }
      parts.push(`Approval rate: ${agency.approvalRate ?? 'n/a'}`);
    }
  }

  if (sources.recentTraceSamples.length > 0) {
    parts.push('');
    parts.push('=== RECENT TRACE SAMPLES (one per line) ===');
    for (const s of sources.recentTraceSamples) {
      parts.push(s);
    }
  }

  return parts.join('\n');
}

/**
 * Try to pull a JSON array out of an LLM response, even if it's wrapped
 * in prose or a code fence. Returns the parsed array or null on failure.
 */
function extractJsonArray(response: string): unknown[] | null {
  // Strip a markdown code fence if present
  let text = response.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) text = fenceMatch[1]!;

  // Find the first '[' and last ']' and slice between them
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

/** Parse an EVO response into PatternObservation records. Pure; no I/O. */
export function parsePatternResponse(
  response: string,
  date: string,
): PatternObservation[] {
  const array = extractJsonArray(response);
  if (!array) return [];

  const patterns: PatternObservation[] = [];
  for (const entry of array) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const observation = typeof e.observation === 'string' ? e.observation : null;
    if (!observation) continue;

    const rawWeight = typeof e.weight === 'number' ? e.weight : 2;
    const weight = Math.max(1, Math.min(5, Math.round(rawWeight)));

    const evidence_refs = Array.isArray(e.evidence_refs)
      ? e.evidence_refs.filter((x) => typeof x === 'string')
      : [];

    patterns.push({
      kind: 'pattern',
      date,
      observation,
      weight,
      evidence_refs,
    });
  }

  return patterns;
}

/** True if the source bundle has any useful data to reason over. */
function sourcesHaveContent(sources: TraceSource): boolean {
  if (sources.recentTraceSamples.length > 0) return true;
  const ta = sources.traceAnalysis;
  if (!ta) return false;
  if (typeof ta.totalTraces === 'number' && ta.totalTraces > 0) return true;
  if (Array.isArray(ta.anomalies) && ta.anomalies.length > 0) return true;
  return false;
}

/**
 * Call EVO 30B with a pattern-extraction prompt over the given source
 * bundle and return structured PatternObservation records. Returns an
 * empty array if sources are empty, the LLM returns null, or parsing fails.
 */
export async function extractPatterns(
  opts: ExtractPatternsOptions,
): Promise<PatternObservation[]> {
  if (!sourcesHaveContent(opts.sources)) return [];

  const userMessage = buildUserMessage(opts.sources);
  const response = await opts.client.chat(SYSTEM_PROMPT, userMessage);
  if (!response) return [];

  return parsePatternResponse(response, opts.date);
}
