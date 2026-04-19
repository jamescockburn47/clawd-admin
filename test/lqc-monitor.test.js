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

async function loadMonitor({ lqcMock, sentMessages, storedNotes = [], progressMock = null, configOverride = null }) {
  const cfg = configOverride ? { default: { ownerJid: 'owner@test', lqcDevGroupJid: '', ...configOverride } } : makeMockConfig();
  const progress = progressMock || {
    lastCompletedRound: (status) => {
      if (typeof status !== 'string') return null;
      const m = /^round_(\d+)$/.exec(status);
      if (m) { const n = Number(m[1]); return n === 0 ? null : n - 1; }
      if (['analysing', 'synthesising', 'complete'].includes(status)) return 4;
      return null;
    },
    buildRoundSummary: async (id, r) => `*Round ${r} complete for ${id}*`,
    buildFinalCommentary: async (id) => `*Debate complete: ${id}*`,
    buildDebateMemoryText: async (id) => `Full memory text for ${id}`,
  };
  const mod = await esmock('../src/tasks/lqc-monitor.js', {
    '../src/lqcouncil/client.js': lqcMock,
    '../src/config.js': cfg,
    '../src/group-registry.js': { findGroupJidByProject: () => null },
    '../src/lqcouncil/debate-progress.js': progress,
    '../src/memory.js': { storeNote: async (text, source) => { storedNotes.push({ text, source }); } },
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

describe('lqc-monitor round progress + complete + memory ingestion', () => {
  it('seeds debateLastRound silently — does NOT announce rounds that completed before first sighting', async () => {
    await runInTempCwd(async () => {
      const d = { id: 'deb-seed', status: 'round_3', created_at: new Date().toISOString(), topic: 'T', bots: [] };
      const sent = [];
      const storedNotes = [];
      const mod = await loadMonitor({ lqcMock: makeMockLqc([d]), sentMessages: sent, storedNotes });
      await mod.tickLqcMonitor();
      const roundMessages = sent.filter((m) => m.text.includes('Round') && m.text.includes('complete for'));
      assert.equal(roundMessages.length, 0, 'initial sighting at round_3 should not retro-post rounds 0-2');
    });
  });

  it('announces a round exactly once when status advances', async () => {
    await runInTempCwd(async () => {
      const d = { id: 'deb-adv', status: 'round_1', created_at: new Date().toISOString(), topic: 'T', bots: [] };
      const sent1 = [];
      const storedNotes1 = [];
      const mod1 = await loadMonitor({ lqcMock: makeMockLqc([d]), sentMessages: sent1, storedNotes: storedNotes1 });
      await mod1.tickLqcMonitor(); // seed at round_1 (lastCompleted=0)
      assert.equal(sent1.filter((m) => m.text.includes('Round')).length, 0);

      d.status = 'round_2';
      await mod1.tickLqcMonitor(); // advance → announce round 1
      const roundAnnounces = sent1.filter((m) => m.text.includes('*Round 1 complete for deb-adv*'));
      assert.equal(roundAnnounces.length, 1, 'round 1 should announce exactly once');

      await mod1.tickLqcMonitor(); // no change
      const after = sent1.filter((m) => m.text.includes('Round 1 complete'));
      assert.equal(after.length, 1, 'no duplicate on idle tick');
    });
  });

  it('announces ALL intermediate rounds when transcript jumps ahead in a single tick gap', async () => {
    await runInTempCwd(async () => {
      const d = { id: 'deb-jump', status: 'round_1', created_at: new Date().toISOString(), topic: 'T', bots: [] };
      const sent = [];
      const storedNotes = [];
      const mod = await loadMonitor({ lqcMock: makeMockLqc([d]), sentMessages: sent, storedNotes });
      await mod.tickLqcMonitor(); // seed, lastCompleted=0
      d.status = 'round_4';
      await mod.tickLqcMonitor(); // jump → rounds 1, 2, 3 should all announce
      const announced = sent.filter((m) => m.text.includes('Round') && m.text.includes('complete for deb-jump'));
      assert.equal(announced.length, 3, `expected 3 round announcements, got ${announced.length}: ${announced.map((a) => a.text).join(' | ')}`);
    });
  });

  it('fires final commentary on complete transition (once) and ingests memory (once)', async () => {
    await runInTempCwd(async () => {
      const d = { id: 'deb-done', status: 'round_4', created_at: new Date().toISOString(), topic: 'T', bots: [] };
      const sent = [];
      const storedNotes = [];
      const mod = await loadMonitor({ lqcMock: makeMockLqc([d]), sentMessages: sent, storedNotes });
      await mod.tickLqcMonitor();
      d.status = 'complete';
      await mod.tickLqcMonitor();

      const finalMsgs = sent.filter((m) => m.text.includes('Debate complete: deb-done'));
      assert.equal(finalMsgs.length, 1, 'commentary posts exactly once');
      assert.equal(storedNotes.length, 1, 'memory ingested exactly once');
      assert.equal(storedNotes[0].source, 'lqc-debate:deb-done');
      assert.ok(storedNotes[0].text.includes('Full memory text for deb-done'));

      await mod.tickLqcMonitor(); // still complete
      assert.equal(sent.filter((m) => m.text.includes('Debate complete: deb-done')).length, 1, 'no re-post');
      assert.equal(storedNotes.length, 1, 'no re-ingest');
    });
  });

  it('backfills memory for completes that were already terminal before monitor started', async () => {
    await runInTempCwd(async () => {
      // Five historical completes already in the system when monitor first boots.
      const debates = Array.from({ length: 5 }, (_, i) => ({
        id: `old-${i}`,
        status: 'complete',
        created_at: new Date(Date.now() - 3600_000).toISOString(),
        topic: `Old ${i}`,
        bots: [],
      }));
      const sent = [];
      const storedNotes = [];
      const mod = await loadMonitor({ lqcMock: makeMockLqc(debates), sentMessages: sent, storedNotes });

      // First tick: backfill throttled to MEMORY_INGEST_PER_TICK=3.
      await mod.tickLqcMonitor();
      assert.equal(storedNotes.length, 3, 'first tick ingests 3 of 5 (throttled)');

      // Second tick: remaining 2.
      await mod.tickLqcMonitor();
      assert.equal(storedNotes.length, 5, 'second tick ingests the remaining 2');

      // No commentary posts because these were already complete when seen (no transition).
      const finalMsgs = sent.filter((m) => m.text.includes('Debate complete:'));
      assert.equal(finalMsgs.length, 0, 'pre-existing completes should not trigger commentary posts');

      // Third tick: all already in memoryIngested set.
      await mod.tickLqcMonitor();
      assert.equal(storedNotes.length, 5, 'no further ingestion');
    });
  });

  it('does NOT re-fire commentary or re-ingest memory after process restart', async () => {
    await runInTempCwd(async () => {
      const d = { id: 'deb-persist', status: 'round_4', created_at: new Date().toISOString(), topic: 'T', bots: [] };
      const sent1 = [];
      const storedNotes1 = [];
      const mod1 = await loadMonitor({ lqcMock: makeMockLqc([d]), sentMessages: sent1, storedNotes: storedNotes1 });
      await mod1.tickLqcMonitor();
      d.status = 'complete';
      await mod1.tickLqcMonitor();
      assert.equal(storedNotes1.length, 1);

      const sent2 = [];
      const storedNotes2 = [];
      const mod2 = await loadMonitor({ lqcMock: makeMockLqc([d]), sentMessages: sent2, storedNotes: storedNotes2 });
      await mod2.tickLqcMonitor();
      assert.equal(sent2.filter((m) => m.text.includes('Debate complete: deb-persist')).length, 0);
      assert.equal(storedNotes2.length, 0, 'memory must not be re-ingested on restart');
    });
  });

  it('author severity goes to LQC_DEV_GROUP_JID (env var) even when allowedProjects resolves a different group', async () => {
    await runInTempCwd(async () => {
      const d = { id: 'deb-dest', status: 'round_1', created_at: new Date().toISOString(), topic: 'T', bots: [] };
      const sent = [];
      const storedNotes = [];
      const mod = await esmock('../src/tasks/lqc-monitor.js', {
        '../src/lqcouncil/client.js': makeMockLqc([d]),
        '../src/config.js': { default: { ownerJid: 'owner@test', lqcDevGroupJid: 'LQCORE@g.us' } },
        '../src/group-registry.js': { findGroupJidByProject: () => 'LQCOUNCIL@g.us' },
        '../src/lqcouncil/debate-progress.js': {
          lastCompletedRound: (s) => s === 'round_1' ? 0 : s === 'round_2' ? 1 : null,
          buildRoundSummary: async (id, r) => `*Round ${r} for ${id}*`,
          buildFinalCommentary: async () => null,
          buildDebateMemoryText: async () => null,
        },
        '../src/memory.js': { storeNote: async () => {} },
      });
      mod.initLqcMonitor(async (jid, text) => { sent.push({ jid, text }); });
      await mod.tickLqcMonitor();            // seed
      d.status = 'round_2';
      await mod.tickLqcMonitor();            // announce round 1
      const roundMsg = sent.find((m) => m.text.includes('Round 1'));
      assert.ok(roundMsg, 'round-1 message should be sent');
      assert.equal(roundMsg.jid, 'LQCORE@g.us', 'env var must win over allowedProjects');
    });
  });
});
