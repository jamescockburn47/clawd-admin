import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

/**
 * Exercises the new persistence + cooldown logic. Each test runs inside
 * a fresh cwd so `data/runtime/lqc-monitor-state.json` doesn't collide
 * between cases or leak into the repo.
 */
async function runInTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lqc-monitor-test-'));
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeMockLqc(debates, opts = {}) {
  return {
    isEnabled: () => true,
    listDebates: async () => debates,
    getDiagHealth: async () => opts.health ?? null,
    listBots: async () => opts.bots ?? [],
    getBotHistory: async () => opts.history ?? [],
  };
}

function makeMockConfig() {
  return { default: { ownerJid: 'owner@test', lqcDevGroupJid: '' } };
}

async function loadMonitor({ lqcMock, sentMessages }) {
  const mod = await esmock('../src/tasks/lqc-monitor.js', {
    '../src/lqcouncil/client.js': lqcMock,
    '../src/config.js': makeMockConfig(),
    '../src/group-registry.js': { findGroupJidByProject: () => null },
  });
  mod.initLqcMonitor(async (jid, text) => { sentMessages.push({ jid, text }); });
  return mod;
}

describe('lqc-monitor persistence and stuck-debate cooldown', () => {
  it('does NOT re-alert a stuck debate after process restart', async () => {
    await runInTempCwd(async () => {
      const stuckDebate = {
        id: 'deb-stuck-1',
        status: 'round_0',
        created_at: new Date(Date.now() - 60 * 60_000).toISOString(), // 60m old
        topic: 'test topic',
        bots: [],
      };
      const lqcMock = makeMockLqc([stuckDebate]);

      // First run — fresh state, stuck alert fires once.
      const sent1 = [];
      const mod1 = await loadMonitor({ lqcMock, sentMessages: sent1 });
      await mod1.tickLqcMonitor();
      const stuckAlerts1 = sent1.filter((m) => m.text.includes('debate stuck'));
      assert.equal(stuckAlerts1.length, 1, 'stuck alert fires on first sighting');

      // Simulate process restart by re-loading the module from disk.
      const sent2 = [];
      const mod2 = await loadMonitor({ lqcMock, sentMessages: sent2 });
      await mod2.tickLqcMonitor();
      const stuckAlerts2 = sent2.filter((m) => m.text.includes('debate stuck'));
      assert.equal(stuckAlerts2.length, 0, 'stuck alert must NOT re-fire after restart');
    });
  });

  it('skips orchestrator-abandoned debates (status=created past 4h)', async () => {
    await runInTempCwd(async () => {
      const abandoned = {
        id: 'deb-abandoned',
        status: 'created',
        created_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(), // 5h old
        topic: 'abandoned topic',
        bots: [],
      };
      const lqcMock = makeMockLqc([abandoned]);

      const sent = [];
      const mod = await loadMonitor({ lqcMock, sentMessages: sent });
      await mod.tickLqcMonitor();

      const stuckAlerts = sent.filter((m) => m.text.includes('debate stuck'));
      assert.equal(stuckAlerts.length, 0, 'status=created past 4h is treated as abandoned, not alerted');
    });
  });

  it('still alerts a genuine stuck debate (status=round_0, <4h old)', async () => {
    await runInTempCwd(async () => {
      const stuck = {
        id: 'deb-genuine',
        status: 'round_0',
        created_at: new Date(Date.now() - 45 * 60_000).toISOString(),
        topic: 'genuine stuck',
        bots: [],
      };
      const lqcMock = makeMockLqc([stuck]);
      const sent = [];
      const mod = await loadMonitor({ lqcMock, sentMessages: sent });
      await mod.tickLqcMonitor();
      const stuckAlerts = sent.filter((m) => m.text.includes('debate stuck'));
      assert.equal(stuckAlerts.length, 1);
      assert.ok(stuckAlerts[0].text.includes('deb-genuine'));
    });
  });

  it('persists cooldowns and debateStatus to disk', async () => {
    await runInTempCwd(async (dir) => {
      const stuck = {
        id: 'deb-persist',
        status: 'round_0',
        created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
        topic: 't',
        bots: [],
      };
      const lqcMock = makeMockLqc([stuck]);
      const sent = [];
      const mod = await loadMonitor({ lqcMock, sentMessages: sent });
      await mod.tickLqcMonitor();

      const statePath = join(dir, 'data', 'runtime', 'lqc-monitor-state.json');
      assert.ok(existsSync(statePath), 'state file should exist');
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.ok(saved.cooldowns[`stuck:${stuck.id}`], 'stuck cooldown persisted');
      assert.equal(saved.debateStatus[stuck.id], 'round_0');
    });
  });

  it('does NOT re-announce a failed debate after restart', async () => {
    await runInTempCwd(async () => {
      const failed = {
        id: 'deb-failed',
        status: 'in_progress',
        created_at: new Date().toISOString(),
        topic: 'will fail',
        bots: [],
      };
      const lqcMock = makeMockLqc([failed]);
      const sent1 = [];
      const mod1 = await loadMonitor({ lqcMock, sentMessages: sent1 });
      await mod1.tickLqcMonitor();
      assert.equal(sent1.filter((m) => m.text.includes('debate failed')).length, 0);

      failed.status = 'failed';
      const sent2 = [];
      const mod2 = await loadMonitor({ lqcMock, sentMessages: sent2 });
      await mod2.tickLqcMonitor();
      assert.equal(sent2.filter((m) => m.text.includes('debate failed')).length, 1, 'fires on transition');

      const sent3 = [];
      const mod3 = await loadMonitor({ lqcMock, sentMessages: sent3 });
      await mod3.tickLqcMonitor();
      assert.equal(sent3.filter((m) => m.text.includes('debate failed')).length, 0, 'no re-announce on restart');
    });
  });
});
