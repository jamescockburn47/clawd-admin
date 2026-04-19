import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let parseModelResponse;
async function load() {
  ({ parseModelResponse } = await import('../src/debate/parser.js'));
}

describe('parseModelResponse', () => {
  beforeEach(async () => { if (!parseModelResponse) await load(); });

  it('parses clean JSON with response field', () => {
    const out = parseModelResponse('{"response": "Hello", "confidence": 80}', 1);
    assert.equal(out.response, 'Hello');
    assert.equal(out.confidence, 80);
  });

  it('strips <think> tags before parsing', () => {
    const raw = '<think>let me think...</think>{"response": "After thought"}';
    const out = parseModelResponse(raw, 0);
    assert.equal(out.response, 'After thought');
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"response": "Fenced"}\n```';
    const out = parseModelResponse(raw, 0);
    assert.equal(out.response, 'Fenced');
  });

  it('extracts embedded JSON when preceded by preamble', () => {
    const raw = 'Here is my answer:\n\n{"response": "Embedded", "confidence": 70}\n\nThat is all.';
    const out = parseModelResponse(raw, 1);
    assert.equal(out.response, 'Embedded');
    assert.equal(out.confidence, 70);
  });

  it('falls back to wrapping raw text when no JSON found, with round-2 shape', () => {
    const out = parseModelResponse('This is just plain text.', 2);
    assert.equal(out.response, 'This is just plain text.');
    assert.equal(out.confidence, 50);
    assert.ok(out.challenge);
    assert.equal(out.challenge.type, 'logical');
  });

  it('falls back with round-4 position_change shape', () => {
    const out = parseModelResponse('Plain text reply', 4);
    assert.equal(out.response, 'Plain text reply');
    assert.ok(out.position_change);
    assert.equal(out.position_change.changed, false);
  });

  it('handles malformed embedded JSON by trying next occurrence', () => {
    const raw = '{"response": unterminated... {"response": "Second attempt", "confidence": 60}';
    const out = parseModelResponse(raw, 1);
    assert.equal(out.response, 'Second attempt');
  });
});
