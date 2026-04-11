import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let parseQueuedItem;

before(async () => {
  ({ parseQueuedItem } = await import('../src/memory.js'));
});

describe('memory queue parsing', () => {
  it('parses valid queued JSON payloads', () => {
    const parsed = parseQueuedItem('{"type":"note","text":"hello"}');
    assert.equal(parsed.type, 'note');
    assert.equal(parsed.text, 'hello');
  });

  it('returns null for empty queue files', () => {
    assert.equal(parseQueuedItem(''), null);
    assert.equal(parseQueuedItem('   '), null);
  });

  it('throws SyntaxError for malformed queue JSON', () => {
    assert.throws(
      () => parseQueuedItem('{'),
      SyntaxError,
    );
  });
});
