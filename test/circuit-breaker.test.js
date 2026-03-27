// test/circuit-breaker.test.js — Circuit breaker state machine: closed → open → half-open → closed
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let CircuitBreaker;

async function loadModules() {
  const mod = await import('../src/circuit-breaker.js');
  ({ CircuitBreaker } = mod);
}

describe('CircuitBreaker', () => {
  let cb;

  beforeEach(async () => {
    if (!CircuitBreaker) await loadModules();
    cb = new CircuitBreaker('test', { threshold: 3, resetTimeout: 1000 });
  });

  it('starts closed with zero failures', () => {
    assert.equal(cb.state, 'closed');
    assert.equal(cb.failures, 0);
  });

  it('stays closed on successful calls', async () => {
    const result = await cb.call(async () => 'ok', 'fallback');
    assert.equal(result, 'ok');
    assert.equal(cb.state, 'closed');
  });

  it('counts failures but stays closed below threshold', async () => {
    await cb.call(() => { throw new Error('1'); }, null);
    assert.equal(cb.failures, 1);
    assert.equal(cb.state, 'closed');

    await cb.call(() => { throw new Error('2'); }, null);
    assert.equal(cb.failures, 2);
    assert.equal(cb.state, 'closed');
  });

  it('opens after reaching failure threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.call(() => { throw new Error(`fail ${i}`); }, null);
    }
    assert.equal(cb.state, 'open');
    assert.equal(cb.failures, 3);
  });

  it('returns fallback value when open', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.call(() => { throw new Error('fail'); }, null);
    }

    const result = await cb.call(
      () => { throw new Error('should not run'); },
      'fallback-data',
    );
    assert.equal(result, 'fallback-data');
  });

  it('calls fallback function when open', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.call(() => { throw new Error('fail'); }, null);
    }

    const result = await cb.call(
      () => { throw new Error('should not run'); },
      () => 'computed-fallback',
    );
    assert.equal(result, 'computed-fallback');
  });

  it('transitions to half-open after resetTimeout', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.call(() => { throw new Error('fail'); }, null);
    }
    assert.equal(cb.state, 'open');

    // Backdate lastFailure to simulate timeout passage
    cb.lastFailure = Date.now() - 2000; // 2s ago, past 1s resetTimeout

    const result = await cb.call(async () => 'recovered', null);
    assert.equal(result, 'recovered');
    assert.equal(cb.state, 'closed');
    assert.equal(cb.failures, 0);
  });

  it('returns to open if half-open test fails', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.call(() => { throw new Error('fail'); }, null);
    }

    cb.lastFailure = Date.now() - 2000; // Allow half-open

    await cb.call(() => { throw new Error('still broken'); }, 'fb');
    // After failure in half-open, failures increment (now 4), goes back to open
    assert.equal(cb.state, 'open');
  });

  it('getStatus returns current state', async () => {
    const status = cb.getStatus();
    assert.equal(status.name, 'test');
    assert.equal(status.state, 'closed');
    assert.equal(status.failures, 0);
  });

  it('reset forces closed state', async () => {
    for (let i = 0; i < 3; i++) {
      await cb.call(() => { throw new Error('fail'); }, null);
    }
    assert.equal(cb.state, 'open');

    cb.reset();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.failures, 0);
  });

  it('uses custom threshold and resetTimeout', async () => {
    const strict = new CircuitBreaker('strict', { threshold: 1, resetTimeout: 500 });
    await strict.call(() => { throw new Error('one'); }, null);
    assert.equal(strict.state, 'open');
  });

  it('uses defaults when no options provided', () => {
    const def = new CircuitBreaker('default');
    assert.equal(def.threshold, 3);
    assert.equal(def.resetTimeout, 60000);
  });
});
