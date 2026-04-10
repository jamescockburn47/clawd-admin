import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, queryEvents, eventLogPath, type OvernightEvent } from '../events.js';

describe('overnight/events', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-events-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('eventLogPath', () => {
    it('returns data/overnight/events-<date>.jsonl shaped path', () => {
      const p = eventLogPath('2026-04-10', { overnightDir: tmpRoot });
      assert.equal(p, join(tmpRoot, 'events-2026-04-10.jsonl'));
    });
  });

  describe('appendEvent', () => {
    const validEvent: Omit<OvernightEvent, 'id' | 'timestamp'> = {
      stage: 'consolidate',
      phase: 'extract',
      inputs: ['data/conversation-logs/2026-04-09.jsonl'],
      outputs: ['memory:abc123'],
      verdict: 'ok',
      reason: 'extracted 12 entries',
      evidence_refs: ['sha256:deadbeef'],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 4200 },
    };

    it('writes a valid event as one JSONL line with id and timestamp filled', async () => {
      const written = await appendEvent(validEvent, {
        date: '2026-04-10',
        overnightDir: tmpRoot,
      });

      assert.ok(written.id, 'id should be populated');
      assert.ok(written.timestamp, 'timestamp should be populated');
      assert.match(written.timestamp, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(written.stage, 'consolidate');

      const file = join(tmpRoot, 'events-2026-04-10.jsonl');
      assert.ok(existsSync(file));
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]!);
      assert.equal(parsed.id, written.id);
      assert.equal(parsed.stage, 'consolidate');
    });

    it('appends multiple events without overwriting', async () => {
      await appendEvent(validEvent, { date: '2026-04-10', overnightDir: tmpRoot });
      await appendEvent(
        { ...validEvent, phase: 'maintenance', reason: 'pruned 3 entries' },
        { date: '2026-04-10', overnightDir: tmpRoot },
      );

      const file = join(tmpRoot, 'events-2026-04-10.jsonl');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]!).phase, 'extract');
      assert.equal(JSON.parse(lines[1]!).phase, 'maintenance');
    });

    it('rejects events missing required fields', async () => {
      const bad = { stage: 'consolidate' } as unknown as Omit<OvernightEvent, 'id' | 'timestamp'>;
      await assert.rejects(
        () => appendEvent(bad, { date: '2026-04-10', overnightDir: tmpRoot }),
        /invalid event/i,
      );
    });

    it('rejects events with an unknown stage', async () => {
      const bad = { ...validEvent, stage: 'bogus' as unknown as OvernightEvent['stage'] };
      await assert.rejects(
        () => appendEvent(bad, { date: '2026-04-10', overnightDir: tmpRoot }),
        /stage/i,
      );
    });
  });

  describe('queryEvents', () => {
    it('returns all events for a single date', async () => {
      const base: Omit<OvernightEvent, 'id' | 'timestamp'> = {
        stage: 'probe',
        phase: 'drift-check',
        inputs: [],
        outputs: [],
        verdict: 'ok',
        reason: 'ok',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      };

      await appendEvent(base, { date: '2026-04-10', overnightDir: tmpRoot });
      await appendEvent({ ...base, phase: 'pattern-scan' }, { date: '2026-04-10', overnightDir: tmpRoot });

      const found = await queryEvents({ date: '2026-04-10', overnightDir: tmpRoot });
      assert.equal(found.length, 2);
      assert.deepEqual(
        found.map((e) => e.phase),
        ['drift-check', 'pattern-scan'],
      );
    });

    it('filters by stage when stage option is provided', async () => {
      const consolidateEvent: Omit<OvernightEvent, 'id' | 'timestamp'> = {
        stage: 'consolidate',
        phase: 'extract',
        inputs: [],
        outputs: [],
        verdict: 'ok',
        reason: '',
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      };
      const probeEvent = { ...consolidateEvent, stage: 'probe' as const, phase: 'drift-check' };

      await appendEvent(consolidateEvent, { date: '2026-04-10', overnightDir: tmpRoot });
      await appendEvent(probeEvent, { date: '2026-04-10', overnightDir: tmpRoot });

      const probes = await queryEvents({ date: '2026-04-10', stage: 'probe', overnightDir: tmpRoot });
      assert.equal(probes.length, 1);
      assert.equal(probes[0]!.stage, 'probe');
    });

    it('returns empty array when no file exists for the date', async () => {
      const found = await queryEvents({ date: '2099-01-01', overnightDir: tmpRoot });
      assert.deepEqual(found, []);
    });
  });
});
