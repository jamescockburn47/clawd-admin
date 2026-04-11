import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isoWeekOf,
  observationLogPath,
  archiveObservationLogPath,
  appendObservation,
  queryObservations,
  rolloverIfMonday,
  type PatternObservation,
  type QualityFailureObservation,
} from '../probe-observations.js';

describe('overnight/probe-observations.isoWeekOf', () => {
  it('returns 2026-W01 for Jan 2 2026 (Fri, in first week since Jan 1 is a Thu)', () => {
    assert.equal(isoWeekOf(new Date('2026-01-02T12:00:00Z')), '2026-W01');
  });

  it('returns correct ISO week for an April date in the middle of the year', () => {
    // 2026-04-11 is a Saturday. ISO W15 runs Mon 2026-04-06 to Sun 2026-04-12.
    assert.equal(isoWeekOf(new Date('2026-04-11T12:00:00Z')), '2026-W15');
  });

  it('handles the year boundary edge case (late Dec date in next year\'s W01)', () => {
    // 2025-12-29 is a Monday, which is in ISO W01 of 2026.
    assert.equal(isoWeekOf(new Date('2025-12-29T12:00:00Z')), '2026-W01');
  });

  it('pads single-digit week numbers with zero', () => {
    // 2026-01-12 is a Monday in W03
    assert.equal(isoWeekOf(new Date('2026-01-12T12:00:00Z')), '2026-W03');
  });
});

describe('overnight/probe-observations.observationLogPath', () => {
  it('returns a path containing the iso-week key', () => {
    const p = observationLogPath('2026-W15', { overnightDir: join('/tmp', 'x') });
    assert.equal(p, join('/tmp', 'x', 'observations-2026-W15.jsonl'));
  });
});

describe('overnight/probe-observations.appendObservation + queryObservations', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-probe-obs-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('appends one observation per call as a JSONL line', async () => {
    const obs: QualityFailureObservation = {
      kind: 'quality_failure',
      date: '2026-04-11',
      category: 'planning',
      rejection_reason: 'cortex gather p95 too slow',
      evidence_refs: ['trace:abc123'],
      weight: 2,
    };
    await appendObservation(obs, { isoWeek: '2026-W15', overnightDir });

    const file = join(overnightDir, 'observations-2026-W15.jsonl');
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.kind, 'quality_failure');
    assert.equal(parsed.category, 'planning');
  });

  it('returns an empty array when no observation file exists', async () => {
    const result = await queryObservations({ isoWeek: '2099-W01', overnightDir });
    assert.deepEqual(result, []);
  });

  it('filters by kind when the kind option is given', async () => {
    const pattern: PatternObservation = {
      kind: 'pattern',
      date: '2026-04-11',
      observation: 'routing to claude-opus twice for the same query',
      evidence_refs: ['trace:a', 'trace:b'],
      weight: 3,
    };
    const failure: QualityFailureObservation = {
      kind: 'quality_failure',
      date: '2026-04-11',
      category: 'planning',
      rejection_reason: 'slow cortex',
      evidence_refs: ['trace:c'],
      weight: 1,
    };
    await appendObservation(pattern, { isoWeek: '2026-W15', overnightDir });
    await appendObservation(failure, { isoWeek: '2026-W15', overnightDir });

    const patterns = await queryObservations({
      isoWeek: '2026-W15',
      overnightDir,
      kind: 'pattern',
    });
    assert.equal(patterns.length, 1);
    assert.equal(patterns[0]!.kind, 'pattern');

    const failures = await queryObservations({
      isoWeek: '2026-W15',
      overnightDir,
      kind: 'quality_failure',
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.kind, 'quality_failure');
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const file = join(overnightDir, 'observations-2026-W15.jsonl');
    mkdirSync(overnightDir, { recursive: true });
    writeFileSync(
      file,
      '{"kind":"pattern","date":"2026-04-11","observation":"good","evidence_refs":[],"weight":1}\nnot valid json\n{"kind":"pattern","date":"2026-04-11","observation":"also good","evidence_refs":[],"weight":1}\n',
    );
    const result = await queryObservations({ isoWeek: '2026-W15', overnightDir });
    assert.equal(result.length, 2);
  });
});

describe('overnight/probe-observations.rolloverIfMonday', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-probe-rollover-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('moves last week\'s log to archive/ when the current date is a Monday', async () => {
    // 2026-04-13 is Monday (start of W16). Previous week is W15.
    const lastWeekFile = join(overnightDir, 'observations-2026-W15.jsonl');
    mkdirSync(overnightDir, { recursive: true });
    writeFileSync(lastWeekFile, '{"kind":"pattern","date":"2026-04-08","observation":"x","evidence_refs":[],"weight":1}\n');

    const result = await rolloverIfMonday(new Date('2026-04-13T12:00:00Z'), { overnightDir });
    assert.equal(result.archivedWeek, '2026-W15');

    const archivePath = archiveObservationLogPath('2026-W15', { overnightDir });
    assert.ok(existsSync(archivePath));
    assert.ok(!existsSync(lastWeekFile));
  });

  it('does nothing on non-Monday days', async () => {
    const result = await rolloverIfMonday(new Date('2026-04-11T12:00:00Z'), { overnightDir });
    assert.equal(result.archivedWeek, null);
  });

  it('does nothing when last week\'s log does not exist', async () => {
    const result = await rolloverIfMonday(new Date('2026-04-13T12:00:00Z'), { overnightDir });
    assert.equal(result.archivedWeek, null);
  });
});
