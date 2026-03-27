// test/scheduler.test.js — Scheduler tick dispatch, task isolation, system health
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let getSystemHealth;

async function loadModules() {
  const mod = await import('../src/scheduler.js');
  ({ getSystemHealth } = mod);
}

describe('getSystemHealth', () => {
  beforeEach(async () => {
    if (!getSystemHealth) await loadModules();
  });

  it('returns all expected subsystem keys', () => {
    const health = getSystemHealth();
    assert.ok('whatsapp' in health);
    assert.ok('evo' in health);
    assert.ok('briefing' in health);
    assert.ok('diary' in health);
    assert.ok('selfImprove' in health);
    assert.ok('knowledgeRefresh' in health);
    assert.ok('projectDeepThink' in health);
    assert.ok('overnightReport' in health);
    assert.ok('backup' in health);
  });

  it('whatsapp shows disconnected before initScheduler', () => {
    const health = getSystemHealth();
    assert.equal(health.whatsapp.connected, false);
  });

  it('evo section has online flag and queueDepth', () => {
    const health = getSystemHealth();
    assert.equal(typeof health.evo.online, 'boolean');
    assert.equal(typeof health.evo.queueDepth, 'number');
  });

  it('briefing section has enabled flag', () => {
    const health = getSystemHealth();
    assert.equal(typeof health.briefing.enabled, 'boolean');
  });
});

describe('getLondonTime (via scheduler internals)', () => {
  // We can't directly test the private function, but we can verify
  // the scheduler module loads without error and the time-dependent
  // logic doesn't crash.

  it('scheduler module loads successfully', async () => {
    const mod = await import('../src/scheduler.js');
    assert.ok(mod.initScheduler);
    assert.ok(mod.getSystemHealth);
  });
});
