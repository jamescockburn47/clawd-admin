import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPatterns,
  parsePatternResponse,
  type EvoChatClient,
  type TraceSource,
} from '../probe-patterns.js';

const SAMPLE_RESPONSE = `[
  {"observation": "needsPlan fired 12 times, only 3 used tools", "weight": 3, "evidence_refs": ["trace:a", "trace:b"]},
  {"observation": "cortex p95 exceeded budget on every planning query", "weight": 4, "evidence_refs": ["trace:c"]}
]`;

describe('overnight/probe-patterns.parsePatternResponse', () => {
  it('parses a valid JSON array response into pattern observations', () => {
    const patterns = parsePatternResponse(SAMPLE_RESPONSE, '2026-04-11');
    assert.equal(patterns.length, 2);
    assert.equal(patterns[0]!.kind, 'pattern');
    assert.equal(patterns[0]!.observation, 'needsPlan fired 12 times, only 3 used tools');
    assert.equal(patterns[0]!.weight, 3);
    assert.deepEqual(patterns[0]!.evidence_refs, ['trace:a', 'trace:b']);
    assert.equal(patterns[0]!.date, '2026-04-11');
  });

  it('returns an empty array when the response is not valid JSON', () => {
    const patterns = parsePatternResponse('not json at all', '2026-04-11');
    assert.deepEqual(patterns, []);
  });

  it('returns an empty array when the response is an object, not an array', () => {
    const patterns = parsePatternResponse('{"not": "array"}', '2026-04-11');
    assert.deepEqual(patterns, []);
  });

  it('skips entries missing the observation field', () => {
    const resp = '[{"observation": "valid", "weight": 2, "evidence_refs": []}, {"weight": 1}]';
    const patterns = parsePatternResponse(resp, '2026-04-11');
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.observation, 'valid');
  });

  it('extracts JSON from a response that contains wrapping text', () => {
    // EVO 30B sometimes wraps JSON in prose or a code fence
    const resp = 'Sure, here are the patterns:\n```json\n' + SAMPLE_RESPONSE + '\n```\nHope this helps.';
    const patterns = parsePatternResponse(resp, '2026-04-11');
    assert.equal(patterns.length, 2);
  });

  it('clamps weight values outside 1-5 range into range', () => {
    const resp = '[{"observation": "a", "weight": 99, "evidence_refs": []}, {"observation": "b", "weight": 0, "evidence_refs": []}]';
    const patterns = parsePatternResponse(resp, '2026-04-11');
    assert.equal(patterns[0]!.weight, 5);
    assert.equal(patterns[1]!.weight, 1);
  });
});

describe('overnight/probe-patterns.extractPatterns', () => {
  function makeClient(response: string | null): EvoChatClient {
    return {
      chat: async () => response,
    };
  }

  function makeSources(overrides: Partial<TraceSource> = {}): TraceSource {
    return {
      traceAnalysis: {
        totalTraces: 30,
        anomalies: [
          { type: 'slow_cortex', severity: 'warning', detail: 'p95 87s', suggestion: 'cache' },
        ],
        categories: { conversational: 9, planning: 5 },
      },
      recentTraceSamples: [
        'James: who won the Cup final | planning | tools: [] | 4.2s',
      ],
      ...overrides,
    };
  }

  it('calls the EVO client with a non-empty user message and returns parsed patterns', async () => {
    let capturedUser = '';
    const client: EvoChatClient = {
      chat: async (_sys, user) => {
        capturedUser = user;
        return SAMPLE_RESPONSE;
      },
    };
    const patterns = await extractPatterns({
      client,
      sources: makeSources(),
      date: '2026-04-11',
    });
    assert.ok(capturedUser.length > 0);
    assert.equal(patterns.length, 2);
    assert.equal(patterns[0]!.kind, 'pattern');
  });

  it('returns an empty array when the EVO client returns null', async () => {
    const patterns = await extractPatterns({
      client: makeClient(null),
      sources: makeSources(),
      date: '2026-04-11',
    });
    assert.deepEqual(patterns, []);
  });

  it('returns an empty array when sources contain no useful data', async () => {
    const patterns = await extractPatterns({
      client: makeClient(SAMPLE_RESPONSE),
      sources: { traceAnalysis: null, recentTraceSamples: [] },
      date: '2026-04-11',
    });
    assert.deepEqual(patterns, []);
  });
});
