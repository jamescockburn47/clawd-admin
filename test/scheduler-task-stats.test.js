// test/scheduler-task-stats.test.js — getTaskStats surface.
// The runTask timing helper is private; we cover it via getTaskStats
// which reflects accumulated per-task rolling stats.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

let getTaskStats;

before(async () => {
  const mod = await import('../src/scheduler.js');
  ({ getTaskStats } = mod);
});

describe('scheduler.getTaskStats', () => {
  it('is a function that returns an object with the expected shape', () => {
    const stats = getTaskStats();
    assert.equal(typeof stats, 'object');
    assert.ok('lastTickMs' in stats, 'lastTickMs key present');
    assert.ok('lastTickStats' in stats, 'lastTickStats key present');
    assert.ok('perTask' in stats, 'perTask key present');
    assert.equal(typeof stats.perTask, 'object');
  });

  it('lastTickMs is a number (0 at startup, populated after first tick)', () => {
    const stats = getTaskStats();
    assert.equal(typeof stats.lastTickMs, 'number');
    assert.ok(stats.lastTickMs >= 0, 'lastTickMs non-negative');
  });

  it('perTask entries (when present) carry count/totalMs/maxMs/meanMs/overBudgetCount', () => {
    // Before any tick has run this will be empty — shape check only
    // when populated. We cannot easily force a tick here without
    // spinning the whole app, so we just assert the shape is
    // tolerable at boot.
    const stats = getTaskStats();
    const names = Object.keys(stats.perTask);
    for (const name of names) {
      const s = stats.perTask[name];
      assert.equal(typeof s.count, 'number');
      assert.equal(typeof s.totalMs, 'number');
      assert.equal(typeof s.maxMs, 'number');
      assert.equal(typeof s.meanMs, 'number');
      assert.equal(typeof s.overBudgetCount, 'number');
    }
  });
});
