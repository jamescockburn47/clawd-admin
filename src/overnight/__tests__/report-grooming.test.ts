import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupByStalenessWindow,
  classifyObservations,
  STALENESS_WINDOW_DAYS,
  MAX_ARCHIVE_WEEKS,
} from '../report-grooming.js';
import type {
  Observation,
  PatternObservation,
  CandidateObservation,
  DriftObservation,
  QualityFailureObservation,
} from '../probe-observations.js';

function makePattern(date: string, observation = 'pattern text', weight = 3): PatternObservation {
  return {
    kind: 'pattern',
    date,
    observation,
    evidence_refs: [`trace:${date}`],
    weight,
  };
}

function makeCandidate(date: string, title = 'candidate title'): CandidateObservation {
  return {
    kind: 'candidate',
    date,
    title,
    category: 'performance',
    predicted_benefit: 'faster',
    scope: 'src/x.js',
    rough_cost: 'small',
    evidence_refs: [`pattern:${date}`],
    weight: 3,
  };
}

function makeDrift(date: string, judged: 'better' | 'worse' | 'neutral' = 'worse'): DriftObservation {
  return {
    kind: 'drift',
    date,
    original_timestamp: `${date}T10:00:00Z`,
    input_hash: 'sha256:abc',
    diff_summary: 'length +20',
    judged,
    reason: 'missed citation',
    evidence_refs: ['sha256:abc'],
    weight: judged === 'worse' ? 5 : 3,
  };
}

function makeQuality(date: string): QualityFailureObservation {
  return {
    kind: 'quality_failure',
    date,
    category: 'planning',
    rejection_reason: 'slow cortex',
    evidence_refs: [`trace-analysis:slow_cortex`],
    weight: 3,
  };
}

describe('overnight/report-grooming.groupByStalenessWindow', () => {
  const now = new Date('2026-04-11T12:00:00Z');

  it('puts observations with date within the current week into currentWeek bucket', () => {
    // Current ISO week of 2026-04-11 is W15 (Mon Apr 6 - Sun Apr 12)
    const obs: Observation[] = [
      makePattern('2026-04-08', 'monday obs'),
      makePattern('2026-04-11', 'today obs'),
    ];
    const result = groupByStalenessWindow(obs, { now });
    assert.equal(result.currentWeek.length, 2);
    assert.equal(result.previousWeeks.length, 0);
    assert.equal(result.dropped.length, 0);
  });

  it('puts observations from older weeks into previousWeeks bucket', () => {
    const obs: Observation[] = [
      makePattern('2026-03-30', 'old obs from 2 weeks ago'), // W14
      makePattern('2026-04-11', 'today obs'), // W15
    ];
    const result = groupByStalenessWindow(obs, { now });
    assert.equal(result.currentWeek.length, 1);
    assert.equal(result.previousWeeks.length, 1);
    assert.equal(result.previousWeeks[0]!.date, '2026-03-30');
  });

  it('drops observations older than MAX_ARCHIVE_WEEKS * 7 days from the dropped list', () => {
    // 15 weeks ago is definitely past the 12-week cutoff
    const obs: Observation[] = [
      makePattern('2025-12-20', 'ancient obs'),
      makePattern('2026-04-11', 'today obs'),
    ];
    const result = groupByStalenessWindow(obs, { now });
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0]!.date, '2025-12-20');
  });
});

describe('overnight/report-grooming.classifyObservations', () => {
  const now = new Date('2026-04-11T12:00:00Z');

  it('returns empty sections when given no observations', () => {
    const result = classifyObservations([], { now });
    assert.deepEqual(result.newThisWeek, []);
    assert.deepEqual(result.continuingWithFreshEvidence, []);
    assert.deepEqual(result.driftAlerts, []);
    assert.deepEqual(result.deferredCandidates, []);
    assert.deepEqual(result.archive, []);
  });

  it('routes "worse" drift observations to driftAlerts regardless of week', () => {
    const obs: Observation[] = [makeDrift('2026-04-11', 'worse')];
    const result = classifyObservations(obs, { now });
    assert.equal(result.driftAlerts.length, 1);
  });

  it('routes current-week candidates to deferredCandidates, sorted by weight', () => {
    const a = makeCandidate('2026-04-10', 'cap timeout');
    a.weight = 2;
    const b = makeCandidate('2026-04-11', 'fix cortex');
    b.weight = 5;
    const result = classifyObservations([a, b], { now });
    assert.equal(result.deferredCandidates.length, 2);
    assert.equal(result.deferredCandidates[0]!.title, 'fix cortex'); // highest weight first
  });

  it('drops current-week candidates with no fresh evidence', () => {
    // A candidate observed this week but whose evidence_refs all point to
    // something from last week should NOT surface. Spec §4.3 hard invariant.
    const stale = makeCandidate('2026-04-11', 'stale thing');
    stale.evidence_refs = ['pattern:2026-03-30']; // points to old week
    const freshPattern = makePattern('2026-04-11', 'fresh');
    const result = classifyObservations([stale, freshPattern], { now });
    // Without a fresh pattern that the candidate references, it should be dropped
    assert.equal(result.deferredCandidates.length, 0);
  });

  it('puts current-week patterns that are new into newThisWeek bucket', () => {
    const obs: Observation[] = [makePattern('2026-04-10', 'new pattern A'), makePattern('2026-04-11', 'new pattern B')];
    const result = classifyObservations(obs, { now });
    assert.equal(result.newThisWeek.length, 2);
  });

  it('archives previous-week observations into the archive bucket', () => {
    // previous week is W14 (2026-03-30 to 2026-04-05)
    const obs: Observation[] = [
      makePattern('2026-03-30', 'prior-week pattern'),
      makeCandidate('2026-04-02', 'prior-week candidate'),
    ];
    const result = classifyObservations(obs, { now });
    assert.equal(result.archive.length, 2);
  });

  it('counts quality failures within the current week', () => {
    const obs: Observation[] = [
      makeQuality('2026-04-10'),
      makeQuality('2026-04-11'),
      makeQuality('2026-03-30'), // previous week
    ];
    const result = classifyObservations(obs, { now });
    assert.equal(result.qualityFailuresCurrentWeek, 2);
  });
});

describe('overnight/report-grooming constants', () => {
  it('exposes STALENESS_WINDOW_DAYS and MAX_ARCHIVE_WEEKS', () => {
    assert.equal(typeof STALENESS_WINDOW_DAYS, 'number');
    assert.equal(typeof MAX_ARCHIVE_WEEKS, 'number');
    assert.ok(STALENESS_WINDOW_DAYS > 0);
    assert.ok(MAX_ARCHIVE_WEEKS > 0);
  });
});
