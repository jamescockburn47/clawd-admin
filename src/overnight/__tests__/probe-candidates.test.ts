import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  proposeCandidates,
  parseCandidateResponse,
  type CandidateSource,
} from '../probe-candidates.js';
import type { EvoChatClient } from '../probe-patterns.js';

const SAMPLE_RESPONSE = `[
  {
    "title": "Cap cortex gather timeout at 15s with fallback to recent-only",
    "category": "performance",
    "predicted_benefit": "Reduce planning-category p95 from 87s to under 20s without losing accuracy",
    "scope": "src/cortex.js:gather() — add Promise.race with 15s timeout and cache fallback",
    "rough_cost": "~40 lines, 1 worktree session, 1 replay pass",
    "evidence_refs": ["pattern:slow_cortex", "quality_failure:planning"]
  },
  {
    "title": "Add needsPlan lint: warn when classifier says true but response uses 0 tools",
    "category": "quality",
    "predicted_benefit": "Catch classifier drift before it becomes silent quality loss",
    "scope": "src/reasoning-trace.js:post-write hook",
    "rough_cost": "~20 lines, no deploy risk",
    "evidence_refs": ["pattern:low_tool_usage"]
  }
]`;

describe('overnight/probe-candidates.parseCandidateResponse', () => {
  it('parses valid candidate responses into CandidateObservation records', () => {
    const candidates = parseCandidateResponse(SAMPLE_RESPONSE, '2026-04-11');
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.kind, 'candidate');
    assert.equal(candidates[0]!.title, 'Cap cortex gather timeout at 15s with fallback to recent-only');
    assert.equal(candidates[0]!.category, 'performance');
    assert.ok(candidates[0]!.scope.includes('src/cortex.js'));
    assert.equal(candidates[0]!.date, '2026-04-11');
    assert.deepEqual(candidates[0]!.evidence_refs, ['pattern:slow_cortex', 'quality_failure:planning']);
  });

  it('assigns a default weight of 3 when the response does not carry one', () => {
    const candidates = parseCandidateResponse(SAMPLE_RESPONSE, '2026-04-11');
    assert.equal(candidates[0]!.weight, 3);
  });

  it('skips entries missing title or scope', () => {
    const resp = `[
      {"title": "valid", "category": "x", "predicted_benefit": "y", "scope": "z", "rough_cost": "q", "evidence_refs": []},
      {"category": "x", "predicted_benefit": "y", "scope": "z"},
      {"title": "valid2", "category": "x", "predicted_benefit": "y", "rough_cost": "q", "evidence_refs": []}
    ]`;
    const candidates = parseCandidateResponse(resp, '2026-04-11');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.title, 'valid');
  });

  it('rejects candidates mentioning banned mission-regression phrases', () => {
    const resp = `[
      {"title": "Simpler cortex by removing memory retrieval", "category": "performance", "predicted_benefit": "faster", "scope": "src/cortex.js", "rough_cost": "small", "evidence_refs": []},
      {"title": "Remove dream mode to save CPU", "category": "capability", "predicted_benefit": "lower load", "scope": "src/dream.js", "rough_cost": "small", "evidence_refs": []},
      {"title": "Cap cortex timeout at 15s", "category": "performance", "predicted_benefit": "speed up", "scope": "src/cortex.js", "rough_cost": "small", "evidence_refs": []}
    ]`;
    const candidates = parseCandidateResponse(resp, '2026-04-11');
    // The two "remove/simpler at cost of capability" candidates should be dropped
    assert.equal(candidates.length, 1);
    assert.match(candidates[0]!.title, /Cap cortex/);
  });

  it('returns empty array on non-JSON input', () => {
    assert.deepEqual(parseCandidateResponse('nothing json here', '2026-04-11'), []);
  });
});

describe('overnight/probe-candidates.proposeCandidates', () => {
  function makeClient(response: string | null): EvoChatClient {
    return {
      chat: async () => response,
    };
  }

  function makeSources(): CandidateSource {
    return {
      patterns: [
        {
          kind: 'pattern',
          date: '2026-04-11',
          observation: 'cortex p95 exceeded 80s',
          weight: 4,
          evidence_refs: ['trace:a'],
        },
      ],
      qualityFailures: [
        {
          kind: 'quality_failure',
          date: '2026-04-11',
          category: 'planning',
          rejection_reason: 'slow_cortex: p95 87s',
          evidence_refs: ['trace-analysis:slow_cortex'],
          weight: 3,
        },
      ],
    };
  }

  it('returns candidates from a valid EVO response', async () => {
    const candidates = await proposeCandidates({
      client: makeClient(SAMPLE_RESPONSE),
      sources: makeSources(),
      date: '2026-04-11',
    });
    assert.equal(candidates.length, 2);
  });

  it('returns empty array when EVO returns null', async () => {
    const candidates = await proposeCandidates({
      client: makeClient(null),
      sources: makeSources(),
      date: '2026-04-11',
    });
    assert.deepEqual(candidates, []);
  });

  it('returns empty array when sources contain no patterns or failures', async () => {
    const candidates = await proposeCandidates({
      client: makeClient(SAMPLE_RESPONSE),
      sources: { patterns: [], qualityFailures: [] },
      date: '2026-04-11',
    });
    assert.deepEqual(candidates, []);
  });
});
