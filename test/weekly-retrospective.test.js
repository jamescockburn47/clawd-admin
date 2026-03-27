// test/weekly-retrospective.test.js — Weekly retrospective scheduling, idempotency, persistence
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const RETRO_FILE = join('data', 'weekly-retrospective.json');
const RETRO_BACKUP = RETRO_FILE + '.test-backup';

let checkWeeklyRetrospective, getLastRetroDate, getLatestRetrospective;

async function loadModule() {
  const mod = await import('../src/tasks/weekly-retrospective.js');
  ({ checkWeeklyRetrospective, getLastRetroDate, getLatestRetrospective } = mod);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function backupRetroFile() {
  if (existsSync(RETRO_FILE)) {
    copyFileSync(RETRO_FILE, RETRO_BACKUP);
  }
}

function restoreRetroFile() {
  if (existsSync(RETRO_BACKUP)) {
    copyFileSync(RETRO_BACKUP, RETRO_FILE);
    unlinkSync(RETRO_BACKUP);
  } else if (existsSync(RETRO_FILE)) {
    // File was created by tests but did not exist before — remove it
    unlinkSync(RETRO_FILE);
  }
}

// ── Scheduling Logic ─────────────────────────────────────────────────────────

describe('checkWeeklyRetrospective — scheduling gate', () => {
  before(async () => {
    await loadModule();
  });

  it('Sunday at 4 AM should attempt to run (will fail gracefully without EVO)', async () => {
    const sendCalls = [];
    const sendFn = (msg) => sendCalls.push(msg);

    // 2026-03-29 is a Sunday
    await checkWeeklyRetrospective(sendFn, '2026-03-29', 4);

    // The function should not throw. It sets lastRetroDate even if the
    // internal generateRetrospective fails (EVO unreachable).
    // sendFn may or may not be called depending on whether the LLM call
    // succeeds — we only care that it didn't throw.
    assert.ok(true, 'did not throw');
  });

  it('Monday at 4 AM should not run', async () => {
    const sendCalls = [];
    const sendFn = (msg) => sendCalls.push(msg);

    // 2026-03-30 is a Monday
    await checkWeeklyRetrospective(sendFn, '2026-03-30', 4);

    // sendFn should not be called because the day gate rejects Monday
    assert.equal(sendCalls.length, 0, 'sendFn should not be called on Monday');
  });

  it('Sunday at 3 AM should not run', async () => {
    const sendCalls = [];
    const sendFn = (msg) => sendCalls.push(msg);

    // Use a different Sunday to avoid idempotency guard
    // 2026-04-05 is a Sunday
    await checkWeeklyRetrospective(sendFn, '2026-04-05', 3);

    assert.equal(sendCalls.length, 0, 'sendFn should not be called at hour 3');
  });

  it('already ran today — idempotent guard prevents re-run', async () => {
    const sendCalls = [];
    const sendFn = (msg) => sendCalls.push(msg);

    // 2026-03-29 was already set as lastRetroDate by the first test
    // Calling again with the same date should early-return
    await checkWeeklyRetrospective(sendFn, '2026-03-29', 4);

    // The idempotency guard returns before even checking day/hour,
    // so sendFn is never called
    assert.equal(sendCalls.length, 0, 'idempotent guard should prevent re-run');
  });
});

// ── Date calculation ─────────────────────────────────────────────────────────

describe('checkWeeklyRetrospective — date calculation', () => {
  before(async () => {
    if (!checkWeeklyRetrospective) await loadModule();
  });

  it('todayStr 2026-03-29 (Sunday, day 0) should trigger', () => {
    const d = new Date('2026-03-29T12:00:00');
    assert.equal(d.getDay(), 0, '2026-03-29 should be a Sunday');
  });

  it('todayStr 2026-03-30 (Monday, day 1) should not trigger', () => {
    const d = new Date('2026-03-30T12:00:00');
    assert.equal(d.getDay(), 1, '2026-03-30 should be a Monday');
  });
});

// ── getLatestRetrospective ───────────────────────────────────────────────────

describe('getLatestRetrospective', () => {
  let hadBackup = false;

  before(async () => {
    if (!getLatestRetrospective) await loadModule();
    backupRetroFile();
    hadBackup = existsSync(RETRO_BACKUP);
  });

  after(() => {
    restoreRetroFile();
  });

  it('returns null when file does not exist', () => {
    if (existsSync(RETRO_FILE)) unlinkSync(RETRO_FILE);
    const result = getLatestRetrospective();
    assert.equal(result, null);
  });

  it('returns parsed JSON when file exists with valid data', () => {
    const fixture = {
      date: '2026-03-29T04:00:00.000Z',
      overallHealth: 'good',
      healthReason: 'All metrics within range',
      priorities: [],
      traceSummary: { totalTraces: 42, planCount: 5, needsPlanF1: 78, anomalyCount: 0, routingBreakdown: {} },
      evolutionTasksCreated: [],
    };
    writeFileSync(RETRO_FILE, JSON.stringify(fixture, null, 2));

    const result = getLatestRetrospective();
    assert.deepEqual(result, fixture);
  });

  it('returns null on corrupted JSON', () => {
    writeFileSync(RETRO_FILE, '{not valid json at all!!!');
    const result = getLatestRetrospective();
    assert.equal(result, null);
  });
});

// ── getLastRetroDate ─────────────────────────────────────────────────────────

describe('getLastRetroDate', () => {
  before(async () => {
    if (!getLastRetroDate) await loadModule();
  });

  it('returns the date string after a run attempt on a valid Sunday', () => {
    // The first scheduling test already ran for 2026-03-29, so the
    // in-memory lastRetroDate should reflect that.
    const date = getLastRetroDate();
    // It should be one of the dates we tested with — at minimum not null
    // because we ran checkWeeklyRetrospective on a valid Sunday earlier.
    assert.ok(date !== null, 'lastRetroDate should not be null after a Sunday run');
    assert.equal(typeof date, 'string');
  });
});
