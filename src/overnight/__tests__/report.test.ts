import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvernightRunner } from '../runner.js';
import { appendEvent, queryEvents } from '../events.js';
import { appendObservation } from '../probe-observations.js';
import { makeReportStage, buildAndRenderReport } from '../report.js';

describe('overnight/report.runReportStage', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-report-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes report-<date>.json and report-<date>.txt and one report event', async () => {
    // Seed a consolidate event for the date
    await appendEvent(
      {
        stage: 'consolidate',
        phase: 'store',
        inputs: [],
        outputs: [],
        verdict: 'ok',
        reason: 'stored=14 rejected=0 store_errors=0',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      },
      { date: '2026-04-11', overnightDir },
    );

    const stage = makeReportStage({
      overnightDir,
      now: () => new Date('2026-04-11T07:00:00Z'),
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-11',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-11T07:00:00Z'),
      skipJanitor: true,
    });
    runner.register('report', stage);
    await runner.run(['report']);

    assert.ok(existsSync(join(overnightDir, 'report-2026-04-11.json')));
    assert.ok(existsSync(join(overnightDir, 'report-2026-04-11.txt')));

    const events = await queryEvents({ date: '2026-04-11', overnightDir, stage: 'report' });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.phase, 'generate');
    assert.equal(events[0]!.verdict, 'ok');
  });

  it('includes current-week observations in the generated report', async () => {
    await appendObservation(
      {
        kind: 'pattern',
        date: '2026-04-11',
        observation: 'cortex consistently slow',
        evidence_refs: ['trace-analysis:slow_cortex'],
        weight: 4,
      },
      { isoWeek: '2026-W15', overnightDir },
    );
    await appendObservation(
      {
        kind: 'candidate',
        date: '2026-04-11',
        title: 'cap cortex timeout',
        category: 'performance',
        predicted_benefit: 'faster planning',
        scope: 'src/cortex.js',
        rough_cost: 'small',
        evidence_refs: ['pattern:2026-04-11'],
        weight: 5,
      },
      { isoWeek: '2026-W15', overnightDir },
    );

    const stage = makeReportStage({
      overnightDir,
      now: () => new Date('2026-04-11T07:00:00Z'),
    });

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-11',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-11T07:00:00Z'),
      skipJanitor: true,
    });
    runner.register('report', stage);
    await runner.run(['report']);

    const text = readFileSync(join(overnightDir, 'report-2026-04-11.txt'), 'utf8');
    assert.match(text, /cap cortex timeout/);
    assert.match(text, /DEFERRED/);
  });
});

describe('overnight/report.buildAndRenderReport', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-report-helper-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('works even when no events or observations exist', async () => {
    const { report, text } = await buildAndRenderReport({
      date: '2026-04-11',
      overnightDir,
      now: new Date('2026-04-11T07:00:00Z'),
    });
    assert.equal(report.events.length, 0);
    assert.match(text, /Overnight/);
    assert.match(text, /No errors/);
  });

  it('reads the event log and observation log and builds a valid report', async () => {
    mkdirSync(overnightDir, { recursive: true });
    // Write an event directly to the log file
    writeFileSync(
      join(overnightDir, 'events-2026-04-11.jsonl'),
      JSON.stringify({
        id: 'test-id',
        timestamp: '2026-04-11T02:30:00.000Z',
        stage: 'consolidate',
        phase: 'store',
        inputs: [],
        outputs: [],
        verdict: 'ok',
        reason: 'stored=7 rejected=0 store_errors=0',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      }) + '\n',
    );

    const { report } = await buildAndRenderReport({
      date: '2026-04-11',
      overnightDir,
      now: new Date('2026-04-11T07:00:00Z'),
    });
    assert.equal(report.events.length, 1);
    assert.equal(report.summary.memoryStored, 7);
  });
});
