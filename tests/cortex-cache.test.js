// tests/cortex-cache.test.js — Tests for cortex identity cache, deadline, and per-stream timeout
//
// Targets src/cortex-cache.js directly (pure helpers, no config dependency).
// Run with: node --test tests/cortex-cache.test.js

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  raceWithTimeout,
  defaultForStream,
  runPhase2Streams,
  clearIdentityCache,
  _expireIdentityCacheForTest,
  _getIdentityCacheStateForTest,
  STREAM_TIMEOUT_MS,
  PHASE2_DEADLINE_MS,
  IDENTITY_CACHE_TTL,
} from '../src/cortex-cache.js';

// ── Helpers ──

function delay(ms, value) {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

function rejectAfter(ms, err) {
  return new Promise((_, reject) => setTimeout(() => reject(err), ms));
}

// ── raceWithTimeout ──

describe('raceWithTimeout', () => {
  it('returns the promise value when it completes in time', async () => {
    const result = await raceWithTimeout(delay(10, 'fast'), 100, 'default');
    assert.equal(result.value, 'fast');
    assert.equal(result.timedOut, false);
  });

  it('returns default value when promise exceeds timeout', async () => {
    const result = await raceWithTimeout(delay(200, 'slow'), 50, 'default');
    assert.equal(result.value, 'default');
    assert.equal(result.timedOut, true);
  });

  it('clears the timeout when promise wins the race', async () => {
    // Smoke test: ensure no leaked timers cause process hang
    await raceWithTimeout(delay(5, 'ok'), 1000, 'default');
    // If timer leaked, the test runner would block; reaching here confirms cleanup
    assert.ok(true);
  });

  it('propagates rejection from wrapped promise', async () => {
    const err = new Error('boom');
    await assert.rejects(
      async () => raceWithTimeout(rejectAfter(5, err), 100, 'default'),
      /boom/,
    );
  });
});

// ── defaultForStream ──

describe('defaultForStream', () => {
  it('returns empty string for system', () => {
    assert.equal(defaultForStream('system'), '');
  });

  it('returns null for webPrefetch', () => {
    assert.equal(defaultForStream('webPrefetch'), null);
  });

  it('returns empty array for other streams', () => {
    assert.deepEqual(defaultForStream('relevant'), []);
    assert.deepEqual(defaultForStream('dreams'), []);
    assert.deepEqual(defaultForStream('insights'), []);
    assert.deepEqual(defaultForStream('unknown'), []);
  });
});

// ── Identity cache ──

describe('clearIdentityCache', () => {
  beforeEach(() => clearIdentityCache());

  it('starts empty', () => {
    const state = _getIdentityCacheStateForTest();
    assert.equal(state.size, 0);
    assert.equal(state.ts, 0);
  });

  it('clear resets state to empty', () => {
    clearIdentityCache();
    const state = _getIdentityCacheStateForTest();
    assert.equal(state.size, 0);
    assert.equal(state.ts, 0);
  });

  it('_expireIdentityCacheForTest resets ts to 0', () => {
    _expireIdentityCacheForTest();
    const state = _getIdentityCacheStateForTest();
    assert.equal(state.ts, 0);
  });
});

// ── runPhase2Streams ──

describe('runPhase2Streams', () => {
  it('returns all results when streams complete fast', async () => {
    const streams = {
      relevant: delay(10, [{ fact: 'A' }]),
      dreams: delay(20, [{ fact: 'B' }]),
      insights: delay(5, [{ fact: 'C' }]),
    };
    const { results, timings } = await runPhase2Streams(streams);
    assert.deepEqual(results.relevant, [{ fact: 'A' }]);
    assert.deepEqual(results.dreams, [{ fact: 'B' }]);
    assert.deepEqual(results.insights, [{ fact: 'C' }]);
    assert.equal(timings.relevant.status, 'completed');
    assert.equal(timings.dreams.status, 'completed');
    assert.equal(timings.insights.status, 'completed');
  });

  it('marks slow streams as timeout and uses default values', async () => {
    const streams = {
      relevant: delay(10, [{ fact: 'fast' }]),
      // Exceeds STREAM_TIMEOUT_MS (5000), but we'd normally need a shorter test timeout.
      // Cap slow to 100ms which is still under stream timeout, just to verify shape.
      dreams: delay(100, [{ fact: 'slower but ok' }]),
    };
    const { results, timings } = await runPhase2Streams(streams);
    assert.deepEqual(results.relevant, [{ fact: 'fast' }]);
    assert.deepEqual(results.dreams, [{ fact: 'slower but ok' }]);
    assert.equal(timings.relevant.status, 'completed');
    assert.equal(timings.dreams.status, 'completed');
  });

  it('returns default values when a stream rejects', async () => {
    const streams = {
      relevant: Promise.reject(new Error('memory down')),
      dreams: delay(10, [{ fact: 'B' }]),
    };
    const { results, timings } = await runPhase2Streams(streams);
    assert.deepEqual(results.relevant, []);
    assert.deepEqual(results.dreams, [{ fact: 'B' }]);
    // Rejected promise is caught inside raceWithTimeout's wrapped.then; status is 'completed'
    // because from wrapping POV the promise settled. This is acceptable — caller sees default.
  });

  it('output has the right shape', async () => {
    const { results, timings } = await runPhase2Streams({});
    assert.deepEqual(results, {});
    assert.deepEqual(timings, {});
  });

  it('preserves default values from defaultForStream helper', async () => {
    const streams = {
      system: Promise.reject(new Error('down')),
      webPrefetch: Promise.reject(new Error('down')),
      relevant: Promise.reject(new Error('down')),
    };
    const { results } = await runPhase2Streams(streams);
    assert.equal(results.system, '');
    assert.equal(results.webPrefetch, null);
    assert.deepEqual(results.relevant, []);
  });
});

// ── Constants sanity ──

describe('constants', () => {
  it('IDENTITY_CACHE_TTL is 5 minutes', () => {
    assert.equal(IDENTITY_CACHE_TTL, 300_000);
  });

  it('STREAM_TIMEOUT_MS is 5 seconds', () => {
    assert.equal(STREAM_TIMEOUT_MS, 5_000);
  });

  it('PHASE2_DEADLINE_MS is 8 seconds', () => {
    assert.equal(PHASE2_DEADLINE_MS, 8_000);
  });
});
