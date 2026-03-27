// test/usage-tracker.test.js — Token counting, daily limits, cost calculation
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let trackTokens, checkDailyLimit, incrementDailyCalls, getDailyCalls,
  recordCallInUsage, getUsageStats;

async function loadModules() {
  const mod = await import('../src/usage-tracker.js');
  ({ trackTokens, checkDailyLimit, incrementDailyCalls, getDailyCalls,
    recordCallInUsage, getUsageStats } = mod);
}

describe('checkDailyLimit', () => {
  beforeEach(async () => {
    if (!checkDailyLimit) await loadModules();
  });

  it('allows calls under the limit', () => {
    // Fresh module has dailyCalls = 0, limit is typically 200
    assert.equal(checkDailyLimit(), true);
  });
});

describe('incrementDailyCalls', () => {
  beforeEach(async () => {
    if (!incrementDailyCalls) await loadModules();
  });

  it('returns incremented count', () => {
    const before = getDailyCalls();
    const after = incrementDailyCalls();
    assert.equal(after, before + 1);
  });
});

describe('trackTokens', () => {
  beforeEach(async () => {
    if (!trackTokens) await loadModules();
  });

  it('accumulates token counts from response usage', () => {
    const statsBefore = getUsageStats();
    const inputBefore = statsBefore.today.input;

    trackTokens({
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
      },
    });

    const statsAfter = getUsageStats();
    assert.equal(statsAfter.today.input, inputBefore + 1000);
    assert.equal(statsAfter.today.output >= 500, true);
    assert.equal(statsAfter.today.cache_write >= 200, true);
    assert.equal(statsAfter.today.cache_read >= 300, true);
  });

  it('handles response with no usage gracefully', () => {
    // Should not throw
    trackTokens({});
    trackTokens({ usage: {} });
  });
});

describe('getUsageStats', () => {
  beforeEach(async () => {
    if (!getUsageStats) await loadModules();
  });

  it('returns structured stats with cost calculation', () => {
    const stats = getUsageStats();
    assert.ok('today' in stats);
    assert.ok('total' in stats);
    assert.ok('cost' in stats.today);
    assert.ok('cost' in stats.total);
    assert.ok('model' in stats);
    assert.ok('dailyLimit' in stats);
    assert.ok('pricing' in stats);
    assert.equal(typeof stats.today.cost, 'number');
    assert.equal(typeof stats.total.cost, 'number');
  });

  it('pricing has expected fields', () => {
    const stats = getUsageStats();
    assert.ok('input' in stats.pricing);
    assert.ok('output' in stats.pricing);
    assert.ok('cache_write' in stats.pricing);
    assert.ok('cache_read' in stats.pricing);
  });
});

describe('recordCallInUsage', () => {
  beforeEach(async () => {
    if (!recordCallInUsage) await loadModules();
  });

  it('syncs daily call count into usage stats', () => {
    const calls = getDailyCalls();
    recordCallInUsage();
    const stats = getUsageStats();
    assert.equal(stats.today.calls, calls);
  });
});
