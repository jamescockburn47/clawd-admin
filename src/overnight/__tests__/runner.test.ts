import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvernightRunner } from '../runner.js';
import { queryEvents } from '../events.js';

describe('overnight/runner.OvernightRunner (skeleton)', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-runner-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs a registered stage and records the event it produces', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      // Skip janitor in tests so it doesn't try to find git.
      skipJanitor: true,
    });

    runner.register('consolidate', async (ctx) => {
      await ctx.appendEvent({
        stage: 'consolidate',
        phase: 'extract',
        inputs: [],
        outputs: ['memory:x'],
        verdict: 'ok',
        reason: 'extracted 1 entry',
        evidence_refs: ['sha256:a'],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 42 },
      });
    });

    await runner.run(['consolidate']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.stage, 'consolidate');
    assert.equal(events[0]!.phase, 'extract');
  });

  it('writes a synthetic "failed: no event produced" event when a stage completes without writing one', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    runner.register('probe', async () => {
      // intentionally writes no event
    });

    await runner.run(['probe']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verdict, 'failed');
    assert.match(events[0]!.reason, /no event produced/i);
  });

  it('writes a synthetic "failed" event when a stage throws', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    runner.register('report', async () => {
      throw new Error('simulated stage failure');
    });

    await runner.run(['report']);

    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verdict, 'failed');
    assert.match(events[0]!.reason, /simulated stage failure/);
  });

  it('refuses to over-run budget and records skipped event', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap', // cap = 1
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    runner.register('improve', async (ctx) => {
      const first = ctx.budget.requestSession({ stage: 'improve', purpose: 'selection' });
      assert.equal(first.allowed, true);
      const second = ctx.budget.requestSession({ stage: 'improve', purpose: 'implement' });
      assert.equal(second.allowed, false);
      await ctx.appendEvent({
        stage: 'improve',
        phase: 'selection',
        inputs: [],
        outputs: [],
        verdict: 'skipped',
        reason: second.reason ?? 'budget',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 1, tokens: 0 },
      });
    });

    await runner.run(['improve']);
    const events = await queryEvents({ date: '2026-04-10', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verdict, 'skipped');
  });

  it('rejects unknown stage names in the run list', async () => {
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-10',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-10T23:00:00Z'),
      skipJanitor: true,
    });

    await assert.rejects(
      () => runner.run(['bogus' as unknown as 'consolidate']),
      /stage "bogus" is not registered/,
    );
  });
});
