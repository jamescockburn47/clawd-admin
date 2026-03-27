// test/constants.test.js — Frozen constants: immutability, completeness, value ranges
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let CATEGORY, TIMEOUTS, LIMITS, COOLDOWNS;

async function loadModules() {
  const mod = await import('../src/constants.js');
  ({ CATEGORY, TIMEOUTS, LIMITS, COOLDOWNS } = mod);
}

describe('CATEGORY', () => {
  it('has all 9 expected categories', async () => {
    if (!CATEGORY) await loadModules();
    const expected = ['CALENDAR', 'TASK', 'TRAVEL', 'EMAIL', 'RECALL',
      'PLANNING', 'CONVERSATIONAL', 'GENERAL_KNOWLEDGE', 'SYSTEM'];
    for (const cat of expected) {
      assert.ok(cat in CATEGORY, `Missing CATEGORY.${cat}`);
    }
  });

  it('values are lowercase strings matching key pattern', async () => {
    if (!CATEGORY) await loadModules();
    for (const [key, val] of Object.entries(CATEGORY)) {
      assert.equal(typeof val, 'string');
      assert.equal(val, key.toLowerCase());
    }
  });

  it('is frozen (immutable)', async () => {
    if (!CATEGORY) await loadModules();
    assert.ok(Object.isFrozen(CATEGORY));
  });
});

describe('TIMEOUTS', () => {
  it('has required timeout keys', async () => {
    if (!TIMEOUTS) await loadModules();
    const required = ['EVO_REQUEST', 'MEMORY_DEFAULT', 'MEMORY_STORE',
      'MEMORY_EXTRACT', 'EVO_HEALTH_CHECK', 'MEMORY_HEALTH_CHECK',
      'EVO_CLASSIFIER'];
    for (const key of required) {
      assert.ok(key in TIMEOUTS, `Missing TIMEOUTS.${key}`);
    }
  });

  it('all values are positive numbers', async () => {
    if (!TIMEOUTS) await loadModules();
    for (const [key, val] of Object.entries(TIMEOUTS)) {
      assert.equal(typeof val, 'number', `${key} should be a number`);
      assert.ok(val > 0, `${key} should be positive`);
    }
  });

  it('classifier timeout is faster than general request timeout', async () => {
    if (!TIMEOUTS) await loadModules();
    assert.ok(TIMEOUTS.EVO_CLASSIFIER < TIMEOUTS.EVO_REQUEST,
      'Classifier (small model) should have a shorter timeout');
  });

  it('is frozen', async () => {
    if (!TIMEOUTS) await loadModules();
    assert.ok(Object.isFrozen(TIMEOUTS));
  });
});

describe('LIMITS', () => {
  it('has evolution scope limits', async () => {
    if (!LIMITS) await loadModules();
    assert.ok('EVOLUTION_MAX_FILES' in LIMITS);
    assert.ok('EVOLUTION_MAX_LINES' in LIMITS);
    assert.equal(LIMITS.EVOLUTION_MAX_FILES, 5);
    assert.equal(LIMITS.EVOLUTION_MAX_LINES, 150);
  });

  it('has message buffer length limit', async () => {
    if (!LIMITS) await loadModules();
    assert.ok('MESSAGE_BUFFER_LENGTH' in LIMITS);
    assert.ok(LIMITS.MESSAGE_BUFFER_LENGTH > 0);
  });

  it('is frozen', async () => {
    if (!LIMITS) await loadModules();
    assert.ok(Object.isFrozen(LIMITS));
  });
});

describe('COOLDOWNS', () => {
  it('has group response cooldown', async () => {
    if (!COOLDOWNS) await loadModules();
    assert.ok('GROUP_RESPONSE' in COOLDOWNS);
    assert.ok(COOLDOWNS.GROUP_RESPONSE > 0);
  });

  it('has mute duration', async () => {
    if (!COOLDOWNS) await loadModules();
    assert.ok('MUTE_DURATION' in COOLDOWNS);
    assert.ok(COOLDOWNS.MUTE_DURATION > 0);
  });

  it('mute is longer than group response cooldown', async () => {
    if (!COOLDOWNS) await loadModules();
    assert.ok(COOLDOWNS.MUTE_DURATION > COOLDOWNS.GROUP_RESPONSE,
      'Mute should be longer than per-message cooldown');
  });

  it('is frozen', async () => {
    if (!COOLDOWNS) await loadModules();
    assert.ok(Object.isFrozen(COOLDOWNS));
  });
});
