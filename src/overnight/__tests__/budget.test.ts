import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetTracker, type BudgetNightMode } from '../budget.js';

describe('overnight/budget.BudgetTracker', () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker({
      mode: 'cheap',
      now: () => new Date('2026-04-10T23:00:00Z'),
    });
  });

  describe('cheap night (1 session limit)', () => {
    it('allows the first session', () => {
      const result = tracker.requestSession({ stage: 'improve', purpose: 'selection' });
      assert.equal(result.allowed, true);
      assert.equal(tracker.sessionsUsed, 1);
    });

    it('refuses the second session', () => {
      tracker.requestSession({ stage: 'improve', purpose: 'selection' });
      const result = tracker.requestSession({ stage: 'improve', purpose: 'implement' });
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? '', /budget exceeded/i);
      assert.equal(tracker.sessionsUsed, 1); // rejected requests do not count
    });
  });

  describe('deep night (2 session limit)', () => {
    beforeEach(() => {
      tracker = new BudgetTracker({
        mode: 'deep',
        now: () => new Date('2026-04-10T23:00:00Z'),
      });
    });

    it('allows two sessions and refuses the third', () => {
      assert.equal(tracker.requestSession({ stage: 'improve', purpose: 'selection' }).allowed, true);
      assert.equal(tracker.requestSession({ stage: 'improve', purpose: 'implement' }).allowed, true);
      const third = tracker.requestSession({ stage: 'improve', purpose: 'fallback' });
      assert.equal(third.allowed, false);
    });
  });

  describe('emergency night (3 session limit)', () => {
    beforeEach(() => {
      tracker = new BudgetTracker({
        mode: 'emergency',
        now: () => new Date('2026-04-10T23:00:00Z'),
      });
    });

    it('allows three sessions and refuses the fourth', () => {
      for (let i = 0; i < 3; i++) {
        assert.equal(tracker.requestSession({ stage: 'improve', purpose: `s${i}` }).allowed, true);
      }
      const fourth = tracker.requestSession({ stage: 'improve', purpose: 'overflow' });
      assert.equal(fourth.allowed, false);
    });
  });

  describe('reset at 22:00 London', () => {
    it('resets counter when now() crosses the 22:00 London boundary', () => {
      // London is UTC+1 in April (BST). 22:00 BST == 21:00 UTC.
      let now = new Date('2026-04-10T20:00:00Z'); // 21:00 BST, before reset
      tracker = new BudgetTracker({ mode: 'cheap', now: () => now });
      tracker.requestSession({ stage: 'improve', purpose: 's1' });
      assert.equal(tracker.sessionsUsed, 1);

      // Advance past the 22:00 BST reset
      now = new Date('2026-04-10T21:30:00Z'); // 22:30 BST, after reset
      tracker.maybeReset();
      assert.equal(tracker.sessionsUsed, 0);
      const after = tracker.requestSession({ stage: 'improve', purpose: 's2' });
      assert.equal(after.allowed, true);
    });
  });

  describe('mode caps snapshot', () => {
    it('exposes the session cap for each mode', () => {
      assert.equal(new BudgetTracker({ mode: 'cheap' as BudgetNightMode }).sessionCap, 1);
      assert.equal(new BudgetTracker({ mode: 'deep' as BudgetNightMode }).sessionCap, 2);
      assert.equal(new BudgetTracker({ mode: 'emergency' as BudgetNightMode }).sessionCap, 3);
    });
  });
});
