import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  groomObservations,
  dedupeCandidates,
  clusterPatterns,
  applyDecay,
} from '../improve-grooming.js';
import { decayedWeight } from '../probe-observations.js';
import type {
  CandidateObservation,
  PatternObservation,
  DriftObservation,
} from '../probe-observations.js';

function makePattern(overrides: Partial<PatternObservation> = {}): PatternObservation {
  return {
    kind: 'pattern',
    date: '2026-04-11',
    observation: 'cortex is slow',
    evidence_refs: ['trace:a'],
    weight: 3,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateObservation> = {}): CandidateObservation {
  return {
    kind: 'candidate',
    date: '2026-04-11',
    title: 'cap cortex timeout',
    category: 'performance',
    predicted_benefit: 'faster',
    scope: 'src/cortex.js',
    rough_cost: 'small',
    evidence_refs: ['pattern:cortex_slow'],
    weight: 3,
    ...overrides,
  };
}

function makeDrift(overrides: Partial<DriftObservation> = {}): DriftObservation {
  return {
    kind: 'drift',
    date: '2026-04-11',
    original_timestamp: '2026-04-11T10:00:00Z',
    input_hash: 'sha256:abc',
    diff_summary: '+20 chars',
    judged: 'worse',
    reason: 'lost citation',
    evidence_refs: ['sha256:abc'],
    weight: 5,
    ...overrides,
  };
}

describe('overnight/improve-grooming.dedupeCandidates', () => {
  it('merges candidates with similar titles, keeping the highest weight', () => {
    const candidates: CandidateObservation[] = [
      makeCandidate({ title: 'Cap cortex timeout at 15s', weight: 2 }),
      makeCandidate({ title: 'Cap cortex timeout to 15 seconds', weight: 4 }),
      makeCandidate({ title: 'Improve router classification accuracy', weight: 3 }),
    ];
    const deduped = dedupeCandidates(candidates);
    assert.equal(deduped.length, 2);
    // The merged "cap cortex timeout" should carry weight 4 (max of the two)
    const cortex = deduped.find((c) => c.title.toLowerCase().includes('cap cortex'));
    assert.ok(cortex);
    assert.equal(cortex!.weight, 4);
  });

  it('leaves dissimilar candidates untouched', () => {
    const candidates: CandidateObservation[] = [
      makeCandidate({ title: 'fix A' }),
      makeCandidate({ title: 'improve B' }),
      makeCandidate({ title: 'add C' }),
    ];
    const deduped = dedupeCandidates(candidates);
    assert.equal(deduped.length, 3);
  });
});

describe('overnight/improve-grooming.clusterPatterns', () => {
  it('groups patterns whose observation text shares keywords', () => {
    const patterns: PatternObservation[] = [
      makePattern({ observation: 'cortex p95 exceeds budget on planning queries' }),
      makePattern({ observation: 'cortex gather is the slowest step in planning' }),
      makePattern({ observation: 'router classifier confused about recall vs general_knowledge' }),
    ];
    const clusters = clusterPatterns(patterns);
    // Two clusters: one about cortex, one about router
    assert.equal(clusters.length, 2);
    const cortexCluster = clusters.find((c) => c.keyword.includes('cortex'));
    assert.ok(cortexCluster);
    assert.equal(cortexCluster!.patterns.length, 2);
  });
});

describe('overnight/improve-grooming.applyDecay', () => {
  const now = new Date('2026-04-11T12:00:00Z').getTime();

  it('leaves recent observations at full weight', () => {
    const p = makePattern({ date: '2026-04-10', weight: 4 });
    const decayed = applyDecay([p], now);
    assert.equal(decayed[0]!.weight, 4);
  });

  it('halves weight for observations 2+ weeks old', () => {
    const p = makePattern({ date: '2026-03-20', weight: 4 });
    const decayed = applyDecay([p], now);
    assert.ok(decayed[0]!.weight < 4);
    assert.ok(decayed[0]!.weight > 0);
  });

  it('drops observations with decayed weight under 0.5', () => {
    const veryOld = makePattern({ date: '2026-01-01', weight: 1 });
    const decayed = applyDecay([veryOld], now);
    assert.equal(decayed.length, 0);
  });

  it('is consistent with probe-observations.decayedWeight', () => {
    const p = makePattern({ date: '2026-03-20', weight: 4 });
    const decayed = applyDecay([p], now);
    const expected = decayedWeight(p, now);
    assert.equal(decayed[0]!.weight, expected);
  });
});

describe('overnight/improve-grooming.groomObservations', () => {
  const now = new Date('2026-04-11T12:00:00Z');

  it('returns empty groups when input is empty', () => {
    const result = groomObservations([], { now });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.patternClusters.length, 0);
    assert.equal(result.worseDriftAlerts.length, 0);
    assert.equal(result.dropped.length, 0);
  });

  it('surfaces worse drift alerts at high priority regardless of pattern weight', () => {
    const result = groomObservations(
      [
        makeDrift({ judged: 'worse', weight: 5 }),
        makePattern({ weight: 4 }),
      ],
      { now },
    );
    assert.equal(result.worseDriftAlerts.length, 1);
  });

  it('drops singleton candidates with weight below 2', () => {
    const result = groomObservations(
      [
        makeCandidate({ weight: 1, title: 'weak candidate' }),
        makeCandidate({ weight: 3, title: 'strong candidate' }),
      ],
      { now },
    );
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.title, 'strong candidate');
  });

  it('dedupes and decays candidates', () => {
    const result = groomObservations(
      [
        makeCandidate({ title: 'cap cortex timeout', weight: 4 }),
        makeCandidate({ title: 'cap cortex timeout at 15s', weight: 3 }),
      ],
      { now },
    );
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.weight, 4);
  });
});
