import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectCandidate,
  parseSelectionResponse,
  type OpusClient,
} from '../improve-opus-select.js';
import type { FinalCandidate } from '../improve-synthesis.js';

function makeCandidates(): FinalCandidate[] {
  return [
    {
      id: 'c1',
      title: 'Cap cortex gather timeout at 15s',
      category: 'performance',
      scope: 'src/cortex.js:gather',
      evidence_refs: ['pattern:cortex_slow', 'quality_failure:slow_cortex'],
      predicted_benefit: 'planning p95 from 87s to 20s without losing accuracy',
    },
    {
      id: 'c2',
      title: 'Add needsPlan drift detector',
      category: 'quality',
      scope: 'src/reasoning-trace.js',
      evidence_refs: ['pattern:low_tool_usage', 'drift:classifier_drift'],
      predicted_benefit: 'catch classifier drift within 24 hours of onset',
    },
  ];
}

describe('overnight/improve-opus-select.parseSelectionResponse', () => {
  const candidates = makeCandidates();

  it('parses a valid selection response with a chosen candidate', () => {
    const resp = `{
      "selected_id": "c1",
      "rationale": "addresses the most-weighted observation and has clear measurable benefit",
      "objections_considered": "timeout may truncate valid long retrievals; mitigated by fallback to cached summary",
      "null_reason": ""
    }`;
    const result = parseSelectionResponse(resp, candidates);
    assert.equal(result.selected_id, 'c1');
    assert.match(result.rationale, /measurable benefit/);
    assert.match(result.objections_considered, /timeout/);
  });

  it('returns null selection when selected_id is null in the response', () => {
    const resp = `{
      "selected_id": null,
      "rationale": "",
      "objections_considered": "",
      "null_reason": "none of the candidates show high-enough mission value this week"
    }`;
    const result = parseSelectionResponse(resp, candidates);
    assert.equal(result.selected_id, null);
    assert.match(result.null_reason ?? '', /mission value/);
  });

  it('returns null selection when Opus hallucinates a candidate id', () => {
    const resp = `{
      "selected_id": "c99",
      "rationale": "picked the best",
      "objections_considered": "none"
    }`;
    const result = parseSelectionResponse(resp, candidates);
    assert.equal(result.selected_id, null);
  });

  it('returns null selection when parsing fails', () => {
    const result = parseSelectionResponse('not valid json', candidates);
    assert.equal(result.selected_id, null);
    assert.match(result.null_reason ?? '', /parse/);
  });

  it('extracts JSON from a markdown-fenced response', () => {
    const resp = 'Here is the selection:\n```json\n{"selected_id":"c1","rationale":"good","objections_considered":"ok"}\n```';
    const result = parseSelectionResponse(resp, candidates);
    assert.equal(result.selected_id, 'c1');
  });

  it('defensively rejects a selected candidate that trips the mission-regression filter', () => {
    const bad: FinalCandidate[] = [
      {
        id: 'regress',
        title: 'Remove memory retrieval to reduce latency',
        category: 'performance',
        scope: 'src/cortex.js',
        evidence_refs: ['pattern:a', 'pattern:b'],
        predicted_benefit: 'faster',
      },
    ];
    const resp = `{"selected_id":"regress","rationale":"faster","objections_considered":"accuracy drops"}`;
    const result = parseSelectionResponse(resp, bad);
    assert.equal(result.selected_id, null);
    assert.match(result.null_reason ?? '', /mission-regression/);
  });
});

describe('overnight/improve-opus-select.selectCandidate', () => {
  function makeClient(response: string | null): OpusClient {
    return {
      callOpus: async () => response,
    };
  }

  it('returns null selection when given an empty candidate list', async () => {
    const result = await selectCandidate({
      client: makeClient('{}'),
      candidates: [],
    });
    assert.equal(result.selected_id, null);
    assert.match(result.null_reason ?? '', /no candidates/);
  });

  it('returns null selection when the Opus client returns null', async () => {
    const result = await selectCandidate({
      client: makeClient(null),
      candidates: makeCandidates(),
    });
    assert.equal(result.selected_id, null);
    assert.match(result.null_reason ?? '', /budget|transient/);
  });

  it('returns the selected candidate id when Opus chooses one', async () => {
    const resp = `{"selected_id":"c1","rationale":"highest mission value","objections_considered":"mitigated"}`;
    const result = await selectCandidate({
      client: makeClient(resp),
      candidates: makeCandidates(),
    });
    assert.equal(result.selected_id, 'c1');
  });
});
