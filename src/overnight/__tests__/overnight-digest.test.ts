import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatOvernightDigest,
  DIGEST_WORD_CAP,
} from '../overnight-digest.js';
import type { OvernightEvent } from '../events.js';

function makeEvent(overrides: Partial<OvernightEvent> = {}): OvernightEvent {
  return {
    id: 'id-' + Math.random().toString(36).slice(2, 8),
    timestamp: '2026-04-11T02:30:00.000Z',
    stage: 'consolidate',
    phase: 'extract',
    inputs: [],
    outputs: [],
    verdict: 'ok',
    reason: 'files=1 candidates=14 errors=0',
    evidence_refs: [],
    rollback_ref: null,
    budget: { opus_sessions: 0, tokens: 0 },
    ...overrides,
  };
}

describe('overnight/overnight-digest.formatOvernightDigest', () => {
  it('returns a "no activity" line when given an empty event list', () => {
    const out = formatOvernightDigest([]);
    assert.match(out, /No overnight activity recorded/i);
  });

  it('renders a happy-path digest with consolidate + operations events', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'consolidate', phase: 'extract', reason: 'files=1 candidates=14 errors=0' }),
      makeEvent({ stage: 'consolidate', phase: 'store', reason: 'stored=14 rejected=0 store_errors=0' }),
      makeEvent({ stage: 'consolidate', phase: 'maintenance', reason: 'maintenance ok' }),
      makeEvent({ stage: 'operations', phase: 'daily-backup', reason: '1.2 GB backed up to /backup/2026-04-11' }),
      makeEvent({ stage: 'operations', phase: 'trace-analyser', reason: '47 traces analysed, 2 quality issues' }),
      makeEvent({ stage: 'operations', phase: 'system-refresh', reason: '3 knowledge files reseeded' }),
      makeEvent({ stage: 'operations', phase: 'ground-truth', reason: '0 new gold-standard entries' }),
    ];
    const out = formatOvernightDigest(events);
    // Headings present
    assert.match(out, /Memory/);
    assert.match(out, /Backup/);
    assert.match(out, /Traces/);
    assert.match(out, /System knowledge/);
    assert.match(out, /Ground truth/);
    // Key substrings from reasons carried through
    assert.match(out, /14 candidate/);
    assert.match(out, /1\.2 GB/);
    assert.match(out, /47 traces/);
    // No errors footer
    assert.match(out, /No errors/);
  });

  it('surfaces failures at the top in an Errors section', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'consolidate', phase: 'extract', verdict: 'ok', reason: 'files=1 candidates=14 errors=0' }),
      makeEvent({ stage: 'operations', phase: 'daily-backup', verdict: 'failed', reason: 'disk full' }),
    ];
    const out = formatOvernightDigest(events);
    // Errors section must appear BEFORE the Memory/Backup detail
    const errorsIdx = out.indexOf('Errors');
    const memoryIdx = out.indexOf('Memory');
    assert.ok(errorsIdx >= 0);
    assert.ok(memoryIdx >= 0);
    assert.ok(errorsIdx < memoryIdx, 'Errors section should be before Memory');
    assert.match(out, /daily-backup/);
    assert.match(out, /disk full/);
  });

  it('says "not run last night" for consolidate stage when no events present', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'operations', phase: 'daily-backup', reason: 'ok' }),
    ];
    const out = formatOvernightDigest(events);
    assert.match(out, /Memory:/);
    assert.match(out, /not run last night/i);
  });

  it('truncates output that exceeds DIGEST_WORD_CAP with an omission pointer', () => {
    // Synthesise many events with long reasons to blow past the cap.
    const events: OvernightEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(
        makeEvent({
          stage: 'operations',
          phase: `synthetic-${i}`,
          reason: 'x '.repeat(30) + `event number ${i}`,
        }),
      );
    }
    const out = formatOvernightDigest(events);
    const wordCount = out.split(/\s+/).filter(Boolean).length;
    assert.ok(
      wordCount <= DIGEST_WORD_CAP + 20,
      `expected <= ${DIGEST_WORD_CAP + 20} words after truncation, got ${wordCount}`,
    );
    assert.match(out, /further events omitted/i);
  });

  it('falls through to a generic renderer for unknown phase names', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'operations', phase: 'brand-new-task', reason: 'did something novel' }),
    ];
    const out = formatOvernightDigest(events);
    assert.match(out, /brand-new-task/);
    assert.match(out, /did something novel/);
  });
});
