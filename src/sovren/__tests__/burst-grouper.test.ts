/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { BurstGrouper, type ClosedBurst } from '../burst-grouper.js';

function setup() {
  const flushed: ClosedBurst[] = [];
  const grouper = new BurstGrouper((burst) => {
    flushed.push(burst);
  }, 1000); // 1 second gap for tests
  return { grouper, flushed };
}

test('burst grouper coalesces messages within the gap window', () => {
  const { grouper, flushed } = setup();
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'g@g.us',
    timestamp: 1000,
    senderName: 'Peter',
    text: 'cover email',
    attachment: null,
  });
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'g@g.us',
    timestamp: 1500,
    senderName: 'Peter',
    text: 'and finally',
    attachment: null,
  });
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'g@g.us',
    timestamp: 1800,
    senderName: 'Peter',
    text: 'template',
    attachment: null,
  });

  assert.equal(grouper.openBurstCount(), 1);
  assert.equal(flushed.length, 0);

  grouper.flushAll();
  assert.equal(flushed.length, 1);
  const burst = flushed[0]!;
  assert.equal(burst.messages.length, 3);
  assert.equal(burst.contributorSlug, 'peter');
  grouper.clearForTest();
});

test('burst grouper opens a new burst after the gap elapses', () => {
  const { grouper, flushed } = setup();
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'g@g.us',
    timestamp: 1000,
    senderName: 'Peter',
    text: 'first',
    attachment: null,
  });
  // Second message arrives long after the gap.
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'g@g.us',
    timestamp: 5000,
    senderName: 'Peter',
    text: 'second burst',
    attachment: null,
  });
  // The first burst should have been flushed when the second arrived.
  assert.equal(flushed.length, 1);
  const first = flushed[0]!;
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0]!.text, 'first');

  grouper.flushAll();
  assert.equal(flushed.length, 2);
  const second = flushed[1]!;
  assert.equal(second.messages[0]!.text, 'second burst');
  grouper.clearForTest();
});

test('burst grouper keys by contributor + chat so different rooms do not merge', () => {
  const { grouper, flushed } = setup();
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'roomA@g.us',
    timestamp: 1000,
    senderName: 'Peter',
    text: 'A1',
    attachment: null,
  });
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'roomB@g.us',
    timestamp: 1100,
    senderName: 'Peter',
    text: 'B1',
    attachment: null,
  });
  assert.equal(grouper.openBurstCount(), 2);
  grouper.flushAll();
  assert.equal(flushed.length, 2);
  grouper.clearForTest();
});

test('closeIdle flushes only bursts past the gap', () => {
  const { grouper, flushed } = setup();
  grouper.record({
    contributorSlug: 'peter',
    chatJid: 'g@g.us',
    timestamp: 1000,
    senderName: 'Peter',
    text: 'old',
    attachment: null,
  });
  grouper.closeIdle(1500); // within gap — no flush
  assert.equal(flushed.length, 0);
  grouper.closeIdle(3000); // past gap — flush
  assert.equal(flushed.length, 1);
  grouper.clearForTest();
});
