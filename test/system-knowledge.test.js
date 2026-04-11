import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let toStringArray;

before(async () => {
  ({ toStringArray } = await import('../src/system-knowledge.js'));
});

describe('system knowledge helpers', () => {
  it('toStringArray keeps only string items', () => {
    assert.deepEqual(
      toStringArray(['a', 1, null, 'b', { x: 1 }]),
      ['a', 'b'],
    );
  });

  it('toStringArray returns empty for non-arrays', () => {
    assert.deepEqual(toStringArray(undefined), []);
    assert.deepEqual(toStringArray({ foo: 'bar' }), []);
    assert.deepEqual(toStringArray('hello'), []);
  });
});
