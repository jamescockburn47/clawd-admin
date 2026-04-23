// test/lqc-daily-health.test.js — buildDailyHealth + checkDailyHealth.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

function makeLqc(overrides = {}) {
  return {
    isEnabled: () => true,
    getDiagHealth: async () => ({ status: 'ok', debates_in_flight: 2, last_completion_ts: '2026-04-23T06:00:00Z' }),
    getPublicConfig: async () => ({ release: 'abc1234' }),
    getModelsDiag: async () => ({ analysis_model: 'MiniMax-M2.7', final_synthesis_model: 'MiniMax-M2.7' }),
    listDebates: async () => {
      const now = Date.now();
      return [
        { id: 'd1', status: 'complete', created_at: new Date(now - 3 * 3600_000).toISOString() },
        { id: 'd2', status: 'failed', created_at: new Date(now - 6 * 3600_000).toISOString() },
        { id: 'd3', status: 'round_2', created_at: new Date(now - 30 * 3600_000).toISOString() },
      ];
    },
    listBots: async () => [
      { id: 'b1', name: 'Oscar', status: 'active' },
      { id: 'b2', name: 'Alice', status: 'pending' },
    ],
    getBotHistory: async (id) => {
      if (id === 'b1') {
        return Array.from({ length: 4 }, () => ({ rounds_total: 5, abstained_rounds: 2, invalid_rounds: 1 }));
      }
      return [];
    },
    ...overrides,
  };
}

function makeSentry(overrides = {}) {
  return {
    isSentryConfigured: () => true,
    searchIssues: async () => [
      { id: 'i1', title: 'timeout at bot', count: 3, lastSeen: '2026-04-23T05:00:00Z', tags: [] },
      { id: 'i2', title: 'json_parse', count: 1, lastSeen: '2026-04-23T04:00:00Z', tags: [] },
    ],
    formatIssues: (issues, { maxItems = 5 } = {}) =>
      issues.slice(0, maxItems).map((i) => `  • [${i.count}×] ${i.title}`).join('\n'),
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    default: {
      ownerJid: 'owner@test',
      lqcSentryProjectFrontend: '',
      ...overrides,
    },
  };
}

async function loadModule({ lqc = makeLqc(), sentry = makeSentry(), config = makeConfig() } = {}) {
  return esmock('../src/tasks/lqc-daily-health.js', {
    '../src/lqcouncil/client.js': lqc,
    '../src/lqcouncil/sentry-client.js': sentry,
    '../src/config.js': config,
  });
}

describe('buildDailyHealth', () => {
  let work;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'lqc-health-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('returns null when lqc integration is disabled', async () => {
    const mod = await loadModule({ lqc: makeLqc({ isEnabled: () => false }) });
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.equal(out, null);
  });

  it('includes all six sections in order', async () => {
    const mod = await loadModule();
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /LQ Council daily health/);
    const idxBackend = out.indexOf('*Backend*');
    const idxActivity = out.indexOf('*Activity (24h)*');
    const idxRouting = out.indexOf('*LLM routing*');
    const idxFleet = out.indexOf('*Bot fleet*');
    const idxSentry = out.indexOf('*Error tracing (24h)*');
    const idxDrift = out.indexOf('*Knowledge drift (24h)*');
    assert.ok(idxBackend >= 0 && idxActivity > idxBackend && idxRouting > idxActivity
      && idxFleet > idxRouting && idxSentry > idxFleet && idxDrift > idxSentry,
      'sections missing or out of order');
  });

  it('renders backend health with release SHA', async () => {
    const mod = await loadModule();
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /\/api\/diag\/health: ok/);
    assert.match(out, /in-flight debates: 2/);
    assert.match(out, /release: abc1234/);
  });

  it('categorises debates correctly into 24h window', async () => {
    const mod = await loadModule();
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /debates: 2 /);                // d1 + d2 within 24h
    assert.match(out, /complete 1, failed 1, in-flight 0/);
  });

  it('flags bots with >=30% abstain/invalid rate', async () => {
    const mod = await loadModule();
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /Oscar: 60% abstain\/invalid/);
  });

  it('shows LLM routing from /api/diag/models', async () => {
    const mod = await loadModule();
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /analyser: MiniMax-M2\.7/);
    assert.match(out, /synthesis: MiniMax-M2\.7/);
  });

  it('falls back cleanly when /api/diag/models is admin-gated', async () => {
    const mod = await loadModule({
      lqc: makeLqc({ getModelsDiag: async () => { throw new Error('401 unauthorized'); } }),
    });
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /admin-gated/);
    assert.doesNotMatch(out, /check failed: 401/);
  });

  it('surfaces Sentry when configured, notes missing frontend project', async () => {
    const mod = await loadModule();
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /backend: 2 issue groups/);
    assert.match(out, /timeout at bot/);
    assert.match(out, /frontend: project slug not set/);
  });

  it('includes frontend Sentry when project slug is set', async () => {
    const calls = [];
    const sentry = {
      isSentryConfigured: () => true,
      searchIssues: async (opts) => {
        calls.push(opts.project || 'default');
        return opts.project === 'fe' ? [{ id: 'f1', title: 'frontend boom', count: 4 }] : [];
      },
      formatIssues: (issues) => issues.map((i) => `  • ${i.title}`).join('\n'),
    };
    const mod = await loadModule({
      sentry,
      config: makeConfig({ lqcSentryProjectFrontend: 'fe' }),
    });
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.ok(calls.includes('fe'), 'frontend project should be queried');
    assert.match(out, /frontend: 1 issue group/);
    assert.match(out, /frontend boom/);
  });

  it('reports "not configured" when Sentry env is absent', async () => {
    const mod = await loadModule({ sentry: makeSentry({ isSentryConfigured: () => false }) });
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /Sentry not configured/);
  });

  it('reports no drift when proposals dir is empty', async () => {
    const mod = await loadModule();
    mkdirSync(work, { recursive: true });
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /none detected \(drift detector clean\)/);
  });

  it('surfaces recent drift proposals with a human summary', async () => {
    const mod = await loadModule();
    const proposal = {
      type: 'lqc-knowledge-drift',
      detected_at: '2026-04-23T02:10:00Z',
      changes: [
        { kind: 'array-diff', field: 'roles', added: ['Mediator'], removed: [] },
        { kind: 'scalar-diff', field: 'roundTimeoutSeconds', old: 300, new: 240 },
      ],
    };
    const fname = `lqc-knowledge-drift-2026-04-23T02-10-00-000Z.json`;
    writeFileSync(join(work, fname), JSON.stringify(proposal));
    const out = await mod.buildDailyHealth({ proposalsDir: work, now: Date.now() });
    assert.match(out, /\+roles:Mediator/);
    assert.match(out, /roundTimeoutSeconds: 300→240/);
    assert.match(out, /Review data\/overnight\/proposals/);
  });

  it('ignores drift proposals older than 30h', async () => {
    const mod = await loadModule();
    const oldFile = join(work, 'lqc-knowledge-drift-old.json');
    writeFileSync(oldFile, JSON.stringify({ changes: [{ kind: 'array-diff', field: 'x', added: ['y'] }] }));
    // Backdate mtime
    const fs = await import('node:fs/promises');
    const past = new Date(Date.now() - 48 * 3600_000);
    await fs.utimes(oldFile, past, past);
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    assert.match(out, /none detected/);
  });

  it('each section survives upstream failure with explicit check-failed line', async () => {
    const mod = await loadModule({
      lqc: makeLqc({
        getDiagHealth: async () => { throw new Error('conn refused'); },
        listDebates: async () => { throw new Error('upstream 500'); },
        getModelsDiag: async () => { throw new Error('nope'); },
        listBots: async () => { throw new Error('dead'); },
      }),
      sentry: makeSentry({ searchIssues: async () => { throw new Error('sentry down'); } }),
    });
    const out = await mod.buildDailyHealth({ proposalsDir: work });
    // Post still produced, every section has its own failure marker
    assert.match(out, /Backend\*\s*\n  \/api\/diag\/health: FAIL — conn refused/);
    assert.match(out, /Activity \(24h\)\*\s*\n  check failed: upstream 500/);
    assert.match(out, /LLM routing\*\s*\n  check failed: nope/);
    assert.match(out, /Bot fleet\*\s*\n  check failed: dead/);
    assert.match(out, /Error tracing \(24h\)\*\s*\n  check failed: sentry down/);
  });
});

describe('checkDailyHealth — scheduler gate', () => {
  let work, origCwd;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'lqc-health-sched-'));
    origCwd = process.cwd();
    process.chdir(work);
    mkdirSync(join(work, 'data', 'runtime'), { recursive: true });
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(work, { recursive: true, force: true });
  });

  it('skips outside the 08:45 slot', async () => {
    const sent = [];
    const mod = await loadModule();
    mod.initDailyHealth(async (jid, text) => { sent.push({ jid, text }); });
    await mod.checkDailyHealth('2026-04-23', 9, 0);
    assert.equal(sent.length, 0);
  });

  it('skips when already sent today', async () => {
    const sent = [];
    const mod = await loadModule();
    mod.initDailyHealth(async (jid, text) => { sent.push({ jid, text }); });
    writeFileSync(join(work, 'data', 'runtime', 'lqc-daily-health-last-run.txt'), '2026-04-23');
    await mod.checkDailyHealth('2026-04-23', 8, 45);
    assert.equal(sent.length, 0);
  });

  it('sends at 08:45 and persists the date', async () => {
    const sent = [];
    const mod = await loadModule();
    mod.initDailyHealth(async (jid, text) => { sent.push({ jid, text }); });
    await mod.checkDailyHealth('2026-04-23', 8, 45);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, 'owner@test');
    assert.match(sent[0].text, /LQ Council daily health/);
    const stamp = readFileSync(join(work, 'data', 'runtime', 'lqc-daily-health-last-run.txt'), 'utf8').trim();
    assert.equal(stamp, '2026-04-23');
  });

  it('honours LQC_HEALTH_GROUP_JID override', async () => {
    const sent = [];
    const mod = await loadModule();
    mod.initDailyHealth(async (jid, text) => { sent.push({ jid, text }); });
    process.env.LQC_HEALTH_GROUP_JID = 'group@test';
    try {
      await mod.checkDailyHealth('2026-04-23', 8, 45);
    } finally {
      delete process.env.LQC_HEALTH_GROUP_JID;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].jid, 'group@test');
  });
});
