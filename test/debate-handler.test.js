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

  it('tolerates MiniMax-style \\\' escapes inside JSON strings', () => {
    // Real failure from debate 90faeeb0 on 2026-04-16 — MiniMax emitted
    // `"Agent C\'s claim"` inside an otherwise-valid JSON payload, which
    // strict JSON.parse rejects, so challenge/position fields were silently
    // replaced with the parser stub.
    const raw = '{"response": "Agent C\\\'s claim is weak", "confidence": 35, "challenge": {"claim_targeted": "the \\\'null round\\\' argument", "counter_evidence": "fallacy", "type": "logical"}}';
    const out = parseModelResponse(raw, 2);
    assert.equal(out.response, "Agent C's claim is weak");
    assert.equal(out.confidence, 35);
    assert.equal(out.challenge.claim_targeted, "the 'null round' argument");
    assert.equal(out.challenge.type, 'logical');
  });

  it('tolerates the same \\\' escapes inside embedded JSON after preamble', () => {
    const raw = 'Based on my research...\n\n{"response": "Agent C\\\'s position", "confidence": 40}';
    const out = parseModelResponse(raw, 1);
    assert.equal(out.response, "Agent C's position");
    assert.equal(out.confidence, 40);
  });

  it('tolerates trailing commas before closing braces/brackets', () => {
    const raw = '{"response": "ok", "confidence": 50, "tags": ["a", "b",],}';
    const out = parseModelResponse(raw, 1);
    assert.equal(out.response, 'ok');
    assert.equal(out.confidence, 50);
    assert.deepEqual(out.tags, ['a', 'b']);
  });
});
