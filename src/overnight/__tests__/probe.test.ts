import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OvernightRunner } from '../runner.js';
import { queryEvents } from '../events.js';
import { makeProbeStage, type ProbeStageDeps } from '../probe.js';
import { queryObservations } from '../probe-observations.js';
import type { EvoChatClient } from '../probe-patterns.js';
import type { TraceAnalysisClient } from '../probe-quality.js';
import type { ReplayClient, GraderClient } from '../probe-drift.js';

describe('overnight/probe.runProbeStage', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let logDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-probe-'));
    overnightDir = join(tmpRoot, 'overnight');
    logDir = join(tmpRoot, 'conversation-logs');
    mkdirSync(logDir);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeLog(name: string, lines: Array<Record<string, unknown>>): void {
    writeFileSync(join(logDir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function makeDeps(overrides: Partial<ProbeStageDeps> = {}): ProbeStageDeps {
    const traceAnalysisClient: TraceAnalysisClient = {
      readAnalysis: async () => ({
        totalTraces: 30,
        anomalies: [
          { type: 'slow_cortex', severity: 'warning', detail: 'p95 87s', suggestion: 'cache' },
        ],
        qualityGate: { totalGated: 2, byCategory: { planning: 2 } },
        categories: { planning: 10, conversational: 20 },
      }),
    };

    const evoChatClient: EvoChatClient = {
      chat: async (system) => {
        if (system.includes('recurring patterns')) {
          return '[{"observation": "cortex consistently slow", "weight": 4, "evidence_refs": ["trace-analysis:slow_cortex"]}]';
        }
        if (system.includes('improvement candidates')) {
          return '[{"title": "Cap cortex gather timeout at 15s", "category": "performance", "predicted_benefit": "cut planning p95", "scope": "src/cortex.js", "rough_cost": "40 lines", "evidence_refs": ["pattern:slow_cortex"]}]';
        }
        return null;
      },
    };

    const replayClient: ReplayClient = {
      replayInput: async () => 'replayed response',
    };

    const graderClient: GraderClient = {
      grade: async () => ({ judged: 'neutral', reason: 'no material change' }),
    };

    return {
      overnightDir,
      logDir,
      traceAnalysisClient,
      evoChatClient,
      replayClient,
      graderClient,
      driftWindowDays: 3,
      driftSampleSize: 5,
      ...overrides,
    };
  }

  it('runs all four probe sub-tasks and writes events + observations', async () => {
    writeLog('2026-04-09-1.jsonl', [
      { sender: 'James', text: 'what is on tomorrow morning?', timestamp: '2026-04-09T10:00:00Z' },
      { sender: 'Clint', text: 'Two meetings: 9am with Alice and 11am with Bob.', isBot: true, timestamp: '2026-04-09T10:00:02Z' },
    ]);

    const stage = makeProbeStage(makeDeps());

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-11',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-11T03:15:00Z'),
      skipJanitor: true,
    });
    runner.register('probe', stage);
    await runner.run(['probe']);

    const events = await queryEvents({ date: '2026-04-11', overnightDir, stage: 'probe' });
    const phases = events.map((e) => e.phase).sort();
    // Four sub-phases: quality, patterns, candidates, drift
    assert.deepEqual(phases, ['candidates', 'drift', 'patterns', 'quality']);

    // Observations written to the correct iso-week file
    const patterns = await queryObservations({
      isoWeek: '2026-W15',
      overnightDir,
      kind: 'pattern',
    });
    assert.ok(patterns.length >= 1, 'expected at least one pattern observation');

    const candidates = await queryObservations({
      isoWeek: '2026-W15',
      overnightDir,
      kind: 'candidate',
    });
    assert.ok(candidates.length >= 1, 'expected at least one candidate observation');

    const failures = await queryObservations({
      isoWeek: '2026-W15',
      overnightDir,
      kind: 'quality_failure',
    });
    assert.ok(failures.length >= 1, 'expected at least one quality failure observation');
  });

  it('completes gracefully when sources are empty (no traces, no logs)', async () => {
    const deps = makeDeps({
      traceAnalysisClient: { readAnalysis: async () => null },
    });

    const stage = makeProbeStage(deps);

    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-11',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-11T03:15:00Z'),
      skipJanitor: true,
    });
    runner.register('probe', stage);
    await runner.run(['probe']);

    const events = await queryEvents({ date: '2026-04-11', overnightDir, stage: 'probe' });
    // Still writes the four phase events even if each has zero observations
    assert.equal(events.length, 4);
    for (const e of events) {
      assert.equal(e.verdict, 'ok');
    }
  });

  it('rolls over the previous week on Monday before writing this week\'s observations', async () => {
    // Pre-create last week's observation file with content
    const lastWeekFile = join(overnightDir, 'observations-2026-W15.jsonl');
    mkdirSync(overnightDir, { recursive: true });
    writeFileSync(
      lastWeekFile,
      JSON.stringify({
        kind: 'pattern',
        date: '2026-04-07',
        observation: 'from last week',
        evidence_refs: [],
        weight: 2,
      }) + '\n',
    );

    writeLog('2026-04-12-1.jsonl', [
      { sender: 'James', text: 'sunday evening question', timestamp: '2026-04-12T20:00:00Z' },
      { sender: 'Clint', text: 'sunday reply', isBot: true, timestamp: '2026-04-12T20:00:02Z' },
    ]);

    const stage = makeProbeStage(makeDeps());

    // Monday 2026-04-13 → new week W16, previous W15 should archive
    const runner = new OvernightRunner({
      mode: 'cheap',
      date: '2026-04-13',
      overnightDir,
      repoRoot: tmpRoot,
      now: () => new Date('2026-04-13T03:15:00Z'),
      skipJanitor: true,
    });
    runner.register('probe', stage);
    await runner.run(['probe']);

    // W15 file should be moved to archive
    assert.ok(!existsSync(lastWeekFile));
    assert.ok(existsSync(join(overnightDir, 'archive', 'observations-2026-W15.jsonl')));
  });
});
