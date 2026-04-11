import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let toStringArray, formatObjectEntries;

before(async () => {
  ({ toStringArray, formatObjectEntries } = await import('../src/system-knowledge.js'));
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

  it('formatObjectEntries returns empty for missing or non-object values', () => {
    assert.equal(formatObjectEntries(undefined), '');
    assert.equal(formatObjectEntries(null), '');
    assert.equal(formatObjectEntries('oops'), '');
  });

  it('formatObjectEntries keeps only string values', () => {
    assert.equal(
      formatObjectEntries({ one: '1', two: 2, three: '3' }),
      'one: 1. three: 3',
    );
  });
});
