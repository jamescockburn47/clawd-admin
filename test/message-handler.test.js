// test/message-handler.test.js — Message handler pure functions: extraction, splitting
// Note: We can't import message-handler.js directly because it pulls in
// document-handler.js → pdf-parse (Pi-only native dep). Instead we test
// the pure logic patterns that the handler relies on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- extractText logic (mirrors src/message-handler.js:extractText) ---

function extractText(message) {
  const msg = message.message;
  if (!msg) return '';
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || msg.documentWithCaptionMessage?.message?.documentMessage?.caption
    || '';
}

describe('extractText', () => {
  it('extracts conversation text', () => {
    assert.equal(extractText({ message: { conversation: 'hello' } }), 'hello');
  });

  it('extracts extendedTextMessage text (quoted replies)', () => {
    assert.equal(extractText({ message: { extendedTextMessage: { text: 'reply' } } }), 'reply');
  });

  it('extracts image caption', () => {
    assert.equal(extractText({ message: { imageMessage: { caption: 'look' } } }), 'look');
  });

  it('extracts video caption', () => {
    assert.equal(extractText({ message: { videoMessage: { caption: 'watch' } } }), 'watch');
  });

  it('extracts document caption', () => {
    assert.equal(extractText({ message: { documentMessage: { caption: 'see' } } }), 'see');
  });

  it('extracts documentWithCaptionMessage (forwarded docs)', () => {
    const msg = {
      message: {
        documentWithCaptionMessage: {
          message: { documentMessage: { caption: 'forwarded' } },
        },
      },
    };
    assert.equal(extractText(msg), 'forwarded');
  });

  it('returns empty for null/undefined/empty message', () => {
    assert.equal(extractText({}), '');
    assert.equal(extractText({ message: null }), '');
    assert.equal(extractText({ message: {} }), '');
  });

  it('prefers conversation over caption fields', () => {
    const msg = {
      message: {
        conversation: 'primary',
        imageMessage: { caption: 'secondary' },
      },
    };
    assert.equal(extractText(msg), 'primary');
  });
});

// --- splitMessage logic (mirrors src/message-handler.js:splitMessage) ---

const MAX_MESSAGE_LENGTH = 3000;

function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitMessage('short message');
    assert.equal(result.length, 1);
    assert.equal(result[0], 'short message');
  });

  it('returns single chunk at exactly 3000 chars', () => {
    assert.equal(splitMessage('a'.repeat(3000)).length, 1);
  });

  it('splits long messages into multiple chunks', () => {
    const text = 'word '.repeat(700); // ~3500 chars
    assert.ok(splitMessage(text).length >= 2);
  });

  it('prefers paragraph breaks for splitting', () => {
    const para1 = 'First paragraph. '.repeat(80); // ~1360 chars
    const para2 = 'Second paragraph. '.repeat(80);
    const para3 = 'Third paragraph. '.repeat(80);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const result = splitMessage(text);
    assert.ok(result.length >= 2);
  });

  it('no chunk exceeds 3000 chars', () => {
    const text = 'x'.repeat(10000);
    for (const chunk of splitMessage(text)) {
      assert.ok(chunk.length <= 3000, `Chunk too long: ${chunk.length}`);
    }
  });

  it('preserves all content (no data loss)', () => {
    const words = Array.from({ length: 800 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const rejoined = splitMessage(text).join(' ');
    for (const w of ['word0', 'word399', 'word799']) {
      assert.ok(rejoined.includes(w), `Missing ${w}`);
    }
  });

  it('handles text with no natural break points', () => {
    const text = 'x'.repeat(6500); // no spaces, newlines
    const result = splitMessage(text);
    assert.ok(result.length >= 3);
    const total = result.reduce((sum, c) => sum + c.length, 0);
    assert.equal(total, 6500);
  });
});

// --- Dedup guard logic ---

describe('dedup guard', () => {
  it('detects duplicate message IDs', () => {
    const seen = new Set();
    const DEDUP_MAX = 200;

    function isDuplicate(msgId) {
      if (!msgId) return false;
      if (seen.has(msgId)) return true;
      seen.add(msgId);
      if (seen.size > DEDUP_MAX) {
        seen.delete(seen.values().next().value);
      }
      return false;
    }

    assert.equal(isDuplicate('msg-001'), false); // first time
    assert.equal(isDuplicate('msg-001'), true);  // duplicate
    assert.equal(isDuplicate('msg-002'), false); // new
    assert.equal(isDuplicate(null), false);       // null never duplicate
  });

  it('evicts oldest when exceeding DEDUP_MAX', () => {
    const seen = new Set();
    const DEDUP_MAX = 5;

    function isDuplicate(msgId) {
      if (!msgId) return false;
      if (seen.has(msgId)) return true;
      seen.add(msgId);
      if (seen.size > DEDUP_MAX) {
        seen.delete(seen.values().next().value);
      }
      return false;
    }

    for (let i = 0; i < 6; i++) isDuplicate(`msg-${i}`);
    assert.equal(seen.size, 5);
    // msg-0 should have been evicted
    assert.equal(isDuplicate('msg-0'), false); // No longer in set
  });
});

// --- WhatsApp approval/rejection regex patterns (from evolution-gate) ---

describe('approval/rejection regex patterns', () => {
  const approveRegex = /^(approve|yes|deploy|merge|go ahead|do it|ship it)\b/i;
  const rejectRegex = /^(reject|no|discard|cancel|don't|nope)\b/i;

  it('matches all approval variants', () => {
    for (const word of ['approve', 'yes', 'deploy', 'merge', 'go ahead', 'do it', 'ship it']) {
      assert.ok(approveRegex.test(word), `Should match: ${word}`);
      assert.ok(approveRegex.test(word.toUpperCase()), `Should match: ${word.toUpperCase()}`);
    }
  });

  it('matches all rejection variants', () => {
    for (const word of ['reject', 'no', 'discard', 'cancel', "don't", 'nope']) {
      assert.ok(rejectRegex.test(word), `Should match: ${word}`);
    }
  });

  it('does not match mid-sentence', () => {
    assert.ok(!approveRegex.test('i might approve later'));
    assert.ok(!rejectRegex.test('maybe reject it'));
  });
});
