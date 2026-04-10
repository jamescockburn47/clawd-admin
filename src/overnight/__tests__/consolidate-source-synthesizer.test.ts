import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeSources,
  SYNTHETIC_HASH_PREFIX,
} from '../consolidate-source-synthesizer.js';
import { MAX_EXCERPT_CHARS } from '../consolidate-validate.js';

describe('overnight/consolidate-source-synthesizer.synthesizeSources', () => {
  it('returns exactly one source', () => {
    const result = synthesizeSources('James: hello world\nClint: hi James');
    assert.equal(result.length, 1);
  });

  it('is deterministic: identical input produces identical hash', () => {
    const input = 'James: the deadline is Tuesday\nClint: noted';
    const a = synthesizeSources(input);
    const b = synthesizeSources(input);
    assert.equal(a[0]!.hash, b[0]!.hash);
    assert.equal(a[0]!.excerpt, b[0]!.excerpt);
  });

  it('different inputs produce different hashes', () => {
    const a = synthesizeSources('first conversation content here');
    const b = synthesizeSources('second conversation content here');
    assert.notEqual(a[0]!.hash, b[0]!.hash);
  });

  it('hash has the synthetic prefix and is the expected sha256 length', () => {
    const [src] = synthesizeSources('any content at all');
    assert.ok(src!.hash.startsWith(SYNTHETIC_HASH_PREFIX));
    // sha256 hex is 64 chars, plus the prefix
    assert.equal(src!.hash.length, SYNTHETIC_HASH_PREFIX.length + 64);
  });

  it('clips excerpt to MAX_EXCERPT_CHARS when conversation is longer', () => {
    const long = 'x'.repeat(MAX_EXCERPT_CHARS + 500);
    const [src] = synthesizeSources(long);
    assert.equal(src!.excerpt.length, MAX_EXCERPT_CHARS);
  });

  it('handles an empty conversation with a stable hash and empty excerpt', () => {
    const [src] = synthesizeSources('');
    assert.ok(src!.hash.startsWith(SYNTHETIC_HASH_PREFIX));
    assert.equal(src!.excerpt, '');
  });
});
