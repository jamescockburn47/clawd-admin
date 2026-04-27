import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

const { shouldPrefetchWeb } = await esmock('../src/cortex.js', {
  '../src/system-knowledge.js': {
    getLiveSystemSnapshot: async () => '',
  },
});

describe('cortex web prefetch selection', () => {
  it('ignores the [Current message] marker when detecting current-info requests', () => {
    assert.equal(
      shouldPrefetchWeb('[Current message]\nJames: List my todos briefly.', 'task'),
      false,
    );
  });

  it('does not prefetch web for local todo phrasing that says current', () => {
    assert.equal(
      shouldPrefetchWeb('[Current message]\nJames: List my current todos briefly.', 'task'),
      false,
    );
  });

  it('still prefetches web for genuine current-info prompts', () => {
    assert.equal(
      shouldPrefetchWeb('[Current message]\nJames: What is the latest Bank of England base rate today?', 'task'),
      true,
    );
  });
});
