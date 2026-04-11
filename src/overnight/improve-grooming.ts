// src/overnight/improve-grooming.ts — groom weekly observations for the IMPROVE stage.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.4 step 2.
//
// Pure functions. Takes a week's worth of raw observations and produces a
// groomed bundle ready for candidate synthesis:
//   - candidates: deduplicated + decayed + singleton-filtered
//   - patternClusters: patterns grouped by dominant keyword
//   - worseDriftAlerts: "worse" drift judgments escalated to the top
//   - dropped: observations filtered out, kept for the report's archive view

import {
  decayedWeight,
  type CandidateObservation,
  type DriftObservation,
  type Observation,
  type PatternObservation,
} from './probe-observations.js';

export interface GroomOptions {
  now: Date;
}

export interface PatternCluster {
  keyword: string;
  patterns: PatternObservation[];
  totalWeight: number;
}

export interface GroomedObservations {
  candidates: CandidateObservation[];
  patternClusters: PatternCluster[];
  worseDriftAlerts: DriftObservation[];
  dropped: Observation[];
}

/** Tokenise a string into lowercase alphanumeric words of length >= 4. */
function tokenise(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 4);
}

/** Jaccard similarity between two token sets (0..1). Empty sets are never similar. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const tok of a) {
    if (b.has(tok)) intersect++;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

const DEDUPE_SIMILARITY_THRESHOLD = 0.55;

/**
 * Merge candidates with similar titles. The surviving candidate keeps the
 * highest weight of the merged group and carries the union of evidence refs.
 */
export function dedupeCandidates(candidates: CandidateObservation[]): CandidateObservation[] {
  const result: CandidateObservation[] = [];

  for (const candidate of candidates) {
    const tokens = new Set(tokenise(candidate.title));
    let mergedInto: CandidateObservation | null = null;

    for (const existing of result) {
      const existingTokens = new Set(tokenise(existing.title));
      if (jaccard(tokens, existingTokens) >= DEDUPE_SIMILARITY_THRESHOLD) {
        mergedInto = existing;
        break;
      }
    }

    if (mergedInto) {
      if (candidate.weight > mergedInto.weight) {
        mergedInto.weight = candidate.weight;
        mergedInto.title = candidate.title; // Keep the higher-weight title
      }
      const combinedRefs = new Set([...mergedInto.evidence_refs, ...candidate.evidence_refs]);
      mergedInto.evidence_refs = Array.from(combinedRefs);
    } else {
      // Clone so later mutations don't affect the caller's array
      result.push({
        ...candidate,
        evidence_refs: [...candidate.evidence_refs],
      });
    }
  }

  return result;
}

const CLUSTER_MIN_SHARED_TOKENS = 2;

/**
 * Pick a representative keyword for a cluster. Returns the token that
 * appears in the most patterns in the cluster, breaking ties by length
 * (longer = more distinctive). Falls back to "misc" for empty clusters.
 */
function pickClusterKeyword(patterns: PatternObservation[]): string {
  if (patterns.length === 0) return 'misc';
  const freq = new Map<string, number>();
  for (const p of patterns) {
    for (const tok of new Set(tokenise(p.observation))) {
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  // Tie-break: on equal frequency, prefer SHORTER tokens. Short distinctive
  // nouns ("cortex", "router") beat longer gerunds ("planning", "classifying")
  // which tend to be generic category labels rather than cluster subjects.
  const sorted = Array.from(freq.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].length - b[0].length;
  });
  return sorted[0]?.[0] ?? 'misc';
}

/**
 * Cluster patterns by shared token overlap. Each pattern joins the first
 * cluster whose seed pattern shares at least CLUSTER_MIN_SHARED_TOKENS tokens;
 * otherwise a new cluster is formed. After all patterns are placed, each
 * cluster's keyword is recomputed as the most-frequent token across its
 * members (more representative than the first pattern's longest word).
 */
export function clusterPatterns(patterns: PatternObservation[]): PatternCluster[] {
  const clusters: PatternCluster[] = [];

  for (const pattern of patterns) {
    const tokens = new Set(tokenise(pattern.observation));
    let placed = false;

    for (const cluster of clusters) {
      const seedTokens = new Set(tokenise(cluster.patterns[0]!.observation));
      let shared = 0;
      for (const tok of tokens) {
        if (seedTokens.has(tok)) shared++;
      }
      if (shared >= CLUSTER_MIN_SHARED_TOKENS) {
        cluster.patterns.push(pattern);
        cluster.totalWeight += pattern.weight;
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({
        keyword: 'pending', // replaced below
        patterns: [pattern],
        totalWeight: pattern.weight,
      });
    }
  }

  // Recompute keywords across all cluster members
  for (const cluster of clusters) {
    cluster.keyword = pickClusterKeyword(cluster.patterns);
  }

  return clusters;
}

/**
 * Apply age-based weight decay. Returns a new array of observations with
 * updated weights. Observations whose decayed weight falls below 0.5 are
 * dropped entirely.
 */
export function applyDecay<T extends Observation>(observations: T[], nowMs: number): T[] {
  const result: T[] = [];
  for (const obs of observations) {
    const newWeight = decayedWeight(obs, nowMs);
    if (newWeight < 0.5) continue;
    result.push({ ...obs, weight: newWeight });
  }
  return result;
}

/**
 * Main grooming entry point. Takes raw weekly observations and produces
 * the groomed bundle the synthesis step will reason over.
 */
export function groomObservations(
  observations: Observation[],
  opts: GroomOptions,
): GroomedObservations {
  const nowMs = opts.now.getTime();

  const result: GroomedObservations = {
    candidates: [],
    patternClusters: [],
    worseDriftAlerts: [],
    dropped: [],
  };

  // Split by kind
  const rawPatterns: PatternObservation[] = [];
  const rawCandidates: CandidateObservation[] = [];
  const rawDrifts: DriftObservation[] = [];

  for (const obs of observations) {
    switch (obs.kind) {
      case 'pattern':
        rawPatterns.push(obs as PatternObservation);
        break;
      case 'candidate':
        rawCandidates.push(obs as CandidateObservation);
        break;
      case 'drift':
        rawDrifts.push(obs as DriftObservation);
        break;
      case 'quality_failure':
        // Quality failures aren't candidates/patterns — they inform the synthesis
        // prompt but don't need grooming. Pass through as part of the archive for now.
        break;
    }
  }

  // Worse drifts are escalated regardless of decay
  result.worseDriftAlerts = rawDrifts.filter((d) => d.judged === 'worse');

  // Apply decay to patterns and candidates
  const decayedPatterns = applyDecay(rawPatterns, nowMs);
  const decayedCandidates = applyDecay(rawCandidates, nowMs);

  // Track dropped-by-decay for reporting
  for (const p of rawPatterns) {
    if (!decayedPatterns.find((d) => d === p || d.observation === p.observation)) {
      result.dropped.push(p);
    }
  }
  for (const c of rawCandidates) {
    if (!decayedCandidates.find((d) => d === c || d.title === c.title)) {
      result.dropped.push(c);
    }
  }

  // Dedupe candidates by similarity
  const deduped = dedupeCandidates(decayedCandidates);

  // Drop singleton candidates with weight < 2 (appeared once, weak signal)
  const titleCounts = new Map<string, number>();
  for (const c of rawCandidates) {
    titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);
  }
  result.candidates = deduped.filter((c) => {
    if (c.weight >= 2) return true;
    const occurrences = titleCounts.get(c.title) ?? 1;
    return occurrences >= 2;
  });

  // Cluster patterns
  result.patternClusters = clusterPatterns(decayedPatterns);

  return result;
}
