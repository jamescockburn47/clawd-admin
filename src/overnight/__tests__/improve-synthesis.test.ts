import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesiseFinalCandidates,
  parseSynthesisResponse,
  type SynthesisSource,
} from '../improve-synthesis.js';
import type { EvoChatClient } from '../probe-patterns.js';
import type { CandidateObservation, PatternObservation, DriftObservation } from '../probe-observations.js';
import type { PatternCluster } from '../improve-grooming.js';

const SAMPLE_RESPONSE = `[
  {"id": "c1", "title": "Cap cortex gather timeout at 15s", "category": "performance", "scope": "src/cortex.js:gather", "evidence_refs": ["pattern:cortex_slow", "quality_failure:slow_cortex"], "predicted_benefit": "planning p95 down from 87s to 20s"},
  {"id": "c2", "title": "Add needsPlan drift detector", "category": "quality", "scope": "src/reasoning-trace.js", "evidence_refs": ["pattern:low_tool_usage", "drift:low_tool_usage"], "predicted_benefit": "catch classifier drift early"}
]`;

describe('overnight/improve-synthesis.parseSynthesisResponse', () => {
  it('parses a valid response into FinalCandidate records', () => {
    const result = parseSynthesisResponse(SAMPLE_RESPONSE);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.id, 'c1');
    assert.equal(result[0]!.title, 'Cap cortex gather timeout at 15s');
    assert.equal(result[0]!.category, 'performance');
    assert.deepEqual(result[0]!.evidence_refs, ['pattern:cortex_slow', 'quality_failure:slow_cortex']);
  });

  it('assigns a synthetic id when the response omits one', () => {
    const resp = `[{"title": "fix cortex", "category": "performance", "scope": "src/cortex.js", "evidence_refs": ["pattern:x", "drift:y"], "predicted_benefit": "faster"}]`;
    const result = parseSynthesisResponse(resp);
    assert.equal(result.length, 1);
    assert.ok(result[0]!.id.length > 0);
  });

  it('rejects candidates with fewer than 2 evidence_refs (spec §4.4 step 3)', () => {
    const resp = `[
      {"id": "ok", "title": "valid", "category": "x", "scope": "src/y.js", "evidence_refs": ["a", "b"], "predicted_benefit": "p"},
      {"id": "bad", "title": "weak evidence", "category": "x", "scope": "src/z.js", "evidence_refs": ["a"], "predicted_benefit": "p"}
    ]`;
    const result = parseSynthesisResponse(resp);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'ok');
  });

  it('rejects candidates with mission-regression titles', () => {
    const resp = `[
      {"id": "bad", "title": "Simpler cortex by removing memory retrieval", "category": "performance", "scope": "src/cortex.js", "evidence_refs": ["a", "b"], "predicted_benefit": "faster"},
      {"id": "ok", "title": "Cap cortex timeout", "category": "performance", "scope": "src/cortex.js", "evidence_refs": ["a", "b"], "predicted_benefit": "faster"}
    ]`;
    const result = parseSynthesisResponse(resp);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.id, 'ok');
  });

  it('returns empty array on non-JSON input', () => {
    assert.deepEqual(parseSynthesisResponse('hello world'), []);
  });
});

describe('overnight/improve-synthesis.synthesiseFinalCandidates', () => {
  function makeClient(response: string | null): EvoChatClient {
    return {
      chat: async () => response,
    };
  }

  function makeGroomed(): SynthesisSource {
    const patterns: PatternObservation[] = [
      {
        kind: 'pattern',
        date: '2026-04-11',
        observation: 'cortex p95 exceeds planning budget',
        evidence_refs: ['trace:a', 'trace:b'],
        weight: 4,
      },
    ];
    const clusters: PatternCluster[] = [
      { keyword: 'cortex', patterns, totalWeight: 4 },
    ];
    const candidates: CandidateObservation[] = [
      {
        kind: 'candidate',
        date: '2026-04-10',
        title: 'timeout cortex',
        category: 'performance',
        predicted_benefit: 'faster',
        scope: 'src/cortex.js',
        rough_cost: 'small',
        evidence_refs: ['pattern:cortex_slow'],
        weight: 4,
      },
    ];
    return {
      candidates,
      patternClusters: clusters,
      worseDriftAlerts: [],
    };
  }

  it('calls EVO with a synthesis prompt and returns parsed candidates', async () => {
    let capturedSystem = '';
    const client: EvoChatClient = {
      chat: async (system) => {
        capturedSystem = system;
        return SAMPLE_RESPONSE;
      },
    };
    const result = await synthesiseFinalCandidates({
      client,
      source: makeGroomed(),
    });
    assert.ok(capturedSystem.length > 0);
    assert.equal(result.length, 2);
  });

  it('returns empty array when EVO returns null', async () => {
    const result = await synthesiseFinalCandidates({
      client: makeClient(null),
      source: makeGroomed(),
    });
    assert.deepEqual(result, []);
  });

  it('returns empty array when source has nothing to synthesise from', async () => {
    const result = await synthesiseFinalCandidates({
      client: makeClient(SAMPLE_RESPONSE),
      source: { candidates: [], patternClusters: [], worseDriftAlerts: [] },
    });
    assert.deepEqual(result, []);
  });

  it('prioritises worse drift alerts by injecting them into the prompt', async () => {
    let capturedUser = '';
    const client: EvoChatClient = {
      chat: async (_, user) => {
        capturedUser = user;
        return SAMPLE_RESPONSE;
      },
    };
    const drift: DriftObservation = {
      kind: 'drift',
      date: '2026-04-11',
      original_timestamp: '2026-04-11T10:00:00Z',
      input_hash: 'sha256:xyz',
      diff_summary: '+50 chars',
      judged: 'worse',
      reason: 'response lost citation to memory',
      evidence_refs: ['sha256:xyz'],
      weight: 5,
    };
    await synthesiseFinalCandidates({
      client,
      source: { ...makeGroomed(), worseDriftAlerts: [drift] },
    });
    assert.match(capturedUser, /DRIFT|WORSE|lost citation/);
  });
});
