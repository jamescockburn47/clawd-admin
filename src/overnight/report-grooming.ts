// src/overnight/report-grooming.ts — observation classification for REPORT stage.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.3.
//
// Pure functions. Takes a list of observations, groups them by staleness
// window, and classifies them into the six report sections: newThisWeek,
// continuingWithFreshEvidence, driftAlerts, deferredCandidates, archive,
// dropped. Applies the "ATLAS guard" invariant: a candidate cannot surface
// as active unless at least one evidence_ref points to an observation
// from the current week.

import { isoWeekOf } from './probe-observations.js';
import type {
  Observation,
  CandidateObservation,
  DriftObservation,
  PatternObservation,
  QualityFailureObservation,
} from './probe-observations.js';

/** Days in the "current week" sliding window for the ATLAS guard. */
export const STALENESS_WINDOW_DAYS = 7;
/** Weeks of archive retention. Anything older is dropped from active view. */
export const MAX_ARCHIVE_WEEKS = 12;

export interface GroomingOptions {
  now: Date;
}

export interface StalenessGroups {
  currentWeek: Observation[];
  previousWeeks: Observation[];
  dropped: Observation[];
}

export interface ClassifiedObservations {
  newThisWeek: Observation[];
  continuingWithFreshEvidence: Observation[];
  driftAlerts: DriftObservation[];
  deferredCandidates: CandidateObservation[];
  archive: Observation[];
  dropped: Observation[];
  qualityFailuresCurrentWeek: number;
  patternsCurrentWeek: number;
  candidatesCurrentWeek: number;
}

function observationDateMs(obs: Observation): number {
  return new Date(obs.date + 'T12:00:00Z').getTime();
}

/**
 * Split observations into currentWeek / previousWeeks / dropped buckets
 * based on the ISO week of their `date` field relative to `now`.
 */
export function groupByStalenessWindow(
  observations: Observation[],
  opts: GroomingOptions,
): StalenessGroups {
  const nowMs = opts.now.getTime();
  const currentWeekKey = isoWeekOf(opts.now);
  const droppedCutoffMs = nowMs - MAX_ARCHIVE_WEEKS * 7 * 86400000;

  const groups: StalenessGroups = {
    currentWeek: [],
    previousWeeks: [],
    dropped: [],
  };

  for (const obs of observations) {
    const obsMs = observationDateMs(obs);
    if (obsMs < droppedCutoffMs) {
      groups.dropped.push(obs);
      continue;
    }
    const obsWeek = isoWeekOf(new Date(obsMs));
    if (obsWeek === currentWeekKey) {
      groups.currentWeek.push(obs);
    } else {
      groups.previousWeeks.push(obs);
    }
  }

  return groups;
}

/**
 * Check whether a candidate's evidence_refs include at least one reference
 * that matches something dated within the current week. This is the
 * ATLAS-fix invariant: candidates without current-week evidence are filtered.
 *
 * The matching is conservative: we look for references whose form includes
 * a date (e.g. "pattern:2026-04-11") or an identifier that appears in the
 * current-week observation set.
 */
function candidateHasFreshEvidence(
  candidate: CandidateObservation,
  currentWeekObservations: Observation[],
  currentWeekKey: string,
): boolean {
  // Build a set of identifiers derived from current-week observations OTHER
  // than the candidate being checked. We deliberately do NOT pull in their
  // evidence_refs — a candidate cannot bootstrap itself by citing its own
  // references. Identity-level match only.
  const currentWeekIds = new Set<string>();
  for (const obs of currentWeekObservations) {
    if (obs === candidate) continue;
    // Dated reference form: "<kind>:<date>"
    currentWeekIds.add(`${obs.kind}:${obs.date}`);
    currentWeekIds.add(obs.date);
  }
  currentWeekIds.add(currentWeekKey);

  // A candidate has fresh evidence if ANY of its refs:
  //   (a) matches the identity of another current-week observation, or
  //   (b) textually contains a YYYY-MM-DD that falls in the current ISO week
  for (const ref of candidate.evidence_refs) {
    if (currentWeekIds.has(ref)) return true;
    const dateMatch = ref.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const refDate = new Date(dateMatch[1]! + 'T12:00:00Z');
      const refWeek = isoWeekOf(refDate);
      if (refWeek === currentWeekKey) return true;
    }
  }
  return false;
}

/**
 * Classify observations into the six REPORT sections plus counters.
 * Applies the staleness window and the ATLAS evidence-chain guard.
 */
export function classifyObservations(
  observations: Observation[],
  opts: GroomingOptions,
): ClassifiedObservations {
  const groups = groupByStalenessWindow(observations, opts);
  const currentWeekKey = isoWeekOf(opts.now);

  const result: ClassifiedObservations = {
    newThisWeek: [],
    continuingWithFreshEvidence: [],
    driftAlerts: [],
    deferredCandidates: [],
    archive: [...groups.previousWeeks],
    dropped: groups.dropped,
    qualityFailuresCurrentWeek: 0,
    patternsCurrentWeek: 0,
    candidatesCurrentWeek: 0,
  };

  // --- Drift alerts (any week, but only "worse" judgments) ---
  for (const obs of observations) {
    if (obs.kind === 'drift' && obs.judged === 'worse') {
      result.driftAlerts.push(obs as DriftObservation);
    }
  }

  // --- Current-week classification ---
  for (const obs of groups.currentWeek) {
    switch (obs.kind) {
      case 'quality_failure':
        result.qualityFailuresCurrentWeek += 1;
        result.newThisWeek.push(obs);
        break;
      case 'pattern':
        result.patternsCurrentWeek += 1;
        result.newThisWeek.push(obs);
        break;
      case 'candidate':
        result.candidatesCurrentWeek += 1;
        // ATLAS guard: candidate must reference current-week evidence
        if (candidateHasFreshEvidence(obs, groups.currentWeek, currentWeekKey)) {
          result.deferredCandidates.push(obs);
        }
        // If it doesn't, the candidate is silently dropped from the active view.
        break;
      case 'drift':
        // Drift handled separately above
        break;
    }
  }

  // Sort deferred candidates by weight descending
  result.deferredCandidates.sort((a, b) => b.weight - a.weight);

  return result;
}
