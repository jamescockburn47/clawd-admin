import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMorningReport, renderReportAsText, MAX_REPORT_WORDS } from '../morning-report.js';
import type { OvernightEvent } from '../events.js';
import type {
  Observation,
  PatternObservation,
  CandidateObservation,
  DriftObservation,
  QualityFailureObservation,
} from '../probe-observations.js';

function makeEvent(overrides: Partial<OvernightEvent> = {}): OvernightEvent {
  return {
    id: `id-${Math.random().toString(36).slice(2, 8)}`,
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

describe('overnight/morning-report.buildMorningReport', () => {
  const now = new Date('2026-04-11T07:00:00Z');

  it('returns an empty-state report when nothing ran overnight', () => {
    const report = buildMorningReport({
      date: '2026-04-11',
      events: [],
      observations: [],
      now,
    });
    assert.equal(report.date, '2026-04-11');
    assert.equal(report.mode, 'cheap');
    assert.equal(report.events.length, 0);
    assert.equal(report.errors.length, 0);
    assert.equal(report.newThisWeek.length, 0);
  });

  it('populates overnight summary counters from consolidate + probe + operations events', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'consolidate', phase: 'store', reason: 'stored=14 rejected=0 store_errors=0' }),
      makeEvent({ stage: 'probe', phase: 'quality', reason: '2 quality_failure observations' }),
      makeEvent({ stage: 'probe', phase: 'patterns', reason: '3 pattern observations' }),
      makeEvent({ stage: 'probe', phase: 'candidates', reason: '4 candidate proposals' }),
      makeEvent({ stage: 'operations', phase: 'daily-backup', reason: '3 files backed up' }),
    ];
    const report = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    assert.equal(report.events.length, 5);
    assert.equal(report.summary.consolidateEvents, 1);
    assert.equal(report.summary.probeEvents, 3);
    assert.equal(report.summary.operationsEvents, 1);
  });

  it('surfaces failed events in the errors section', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'operations', phase: 'daily-backup', verdict: 'failed', reason: 'disk full' }),
      makeEvent({ stage: 'consolidate', phase: 'extract', verdict: 'ok' }),
    ];
    const report = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!.reason, /disk full/);
  });

  it('classifies observations into sections via report-grooming', () => {
    const obs: Observation[] = [
      {
        kind: 'pattern',
        date: '2026-04-11',
        observation: 'cortex slow',
        evidence_refs: [],
        weight: 3,
      } as PatternObservation,
      {
        kind: 'candidate',
        date: '2026-04-11',
        title: 'cap timeout',
        category: 'performance',
        predicted_benefit: 'faster',
        scope: 'src/cortex.js',
        rough_cost: 'small',
        evidence_refs: ['pattern:2026-04-11'],
        weight: 4,
      } as CandidateObservation,
      {
        kind: 'drift',
        date: '2026-04-10',
        original_timestamp: '2026-04-10T10:00:00Z',
        input_hash: 'sha256:a',
        diff_summary: '+20 chars',
        judged: 'worse',
        reason: 'missed citation',
        evidence_refs: ['sha256:a'],
        weight: 5,
      } as DriftObservation,
    ];
    const report = buildMorningReport({ date: '2026-04-11', events: [], observations: obs, now });
    assert.ok(report.newThisWeek.length >= 1);
    assert.equal(report.deferredCandidates.length, 1);
    assert.equal(report.driftAlerts.length, 1);
  });

  it('reports budget section with opus sessions used', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'improve', phase: 'opus-select', budget: { opus_sessions: 1, tokens: 4200 } }),
      makeEvent({ stage: 'improve', phase: 'implement', budget: { opus_sessions: 1, tokens: 9000 } }),
      makeEvent({ stage: 'consolidate', phase: 'extract', budget: { opus_sessions: 0, tokens: 0 } }),
    ];
    const report = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    assert.equal(report.budget.opus_sessions_used, 2);
    assert.equal(report.budget.tokens_used, 13200);
  });

  it('detects deep mode when improve stage fired', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'improve', phase: 'synthesis' }),
    ];
    const report = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    assert.equal(report.mode, 'deep');
  });
});

describe('overnight/morning-report.renderReportAsText', () => {
  const now = new Date('2026-04-11T07:00:00Z');

  it('renders a non-empty report to plain text with expected sections', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'consolidate', phase: 'extract', reason: 'files=1 candidates=14 errors=0' }),
      makeEvent({ stage: 'consolidate', phase: 'store', reason: 'stored=14 rejected=0 store_errors=0' }),
      makeEvent({ stage: 'operations', phase: 'daily-backup', reason: '3 files backed up' }),
    ];
    const built = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    const { text, ...report } = built;
    assert.equal(text, renderReportAsText(report));

    assert.match(text, /Overnight/);
    assert.match(text, /Memory/);
    assert.match(text, /Backup/);
    assert.doesNotMatch(text, /undefined/);
  });

  it('puts errors at the top of the rendered output', () => {
    const events: OvernightEvent[] = [
      makeEvent({ stage: 'operations', phase: 'daily-backup', verdict: 'failed', reason: 'disk full' }),
      makeEvent({ stage: 'consolidate', phase: 'extract', reason: 'ok' }),
    ];
    const built = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    const { text, ...report } = built;
    assert.equal(text, renderReportAsText(report));

    const errorsIdx = text.indexOf('Errors');
    const memoryIdx = text.indexOf('Memory');
    assert.ok(errorsIdx >= 0, 'Errors section present');
    assert.ok(memoryIdx >= 0, 'Memory section present');
    assert.ok(errorsIdx < memoryIdx, 'Errors before Memory');
  });

  it('truncates output that exceeds MAX_REPORT_WORDS with a pointer', () => {
    // Synthesize hundreds of events to blow past the cap
    const events: OvernightEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(
        makeEvent({
          stage: 'operations',
          phase: `synthetic-${i}`,
          reason: 'x '.repeat(15) + `event ${i}`,
        }),
      );
    }
    const built = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    const { text, ...report } = built;
    assert.equal(text, renderReportAsText(report));
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    assert.ok(
      wordCount <= MAX_REPORT_WORDS + 20,
      `expected <= ${MAX_REPORT_WORDS + 20} words after truncation, got ${wordCount}`,
    );
    assert.match(text, /further events omitted/i);
  });

  it('shows the NEW this week and DEFERRED sections when observations present', () => {
    const obs: Observation[] = [
      {
        kind: 'pattern',
        date: '2026-04-11',
        observation: 'cortex p95 spike',
        evidence_refs: [],
        weight: 4,
      } as PatternObservation,
      {
        kind: 'candidate',
        date: '2026-04-11',
        title: 'cap cortex timeout',
        category: 'performance',
        predicted_benefit: 'faster',
        scope: 'src/cortex.js',
        rough_cost: 'small',
        evidence_refs: ['pattern:2026-04-11'],
        weight: 5,
      } as CandidateObservation,
    ];
    const built = buildMorningReport({ date: '2026-04-11', events: [], observations: obs, now });
    const { text, ...report } = built;
    assert.equal(text, renderReportAsText(report));
    assert.match(text, /NEW/i);
    assert.match(text, /DEFERRED/i);
    assert.match(text, /cap cortex/);
  });

  it('renders a clear standalone research and self-improvement section without legacy project wording', () => {
    const events: OvernightEvent[] = [
      makeEvent({
        stage: 'operations',
        phase: 'overnight-research',
        outputs: ['research:AI agents with browser automation', 'source:https://example.com/agents'],
        reason: 'researched 1 topic using SearXNG',
      }),
      makeEvent({
        stage: 'improve',
        phase: 'deploy',
        outputs: ['forge/wt-test'],
        verdict: 'ok',
        reason: 'approval required: Tier B branch passed CI + replay',
      }),
    ];
    const built = buildMorningReport({ date: '2026-04-11', events, observations: [], now });
    const { text, ...report } = built;

    assert.equal(text, renderReportAsText(report));
    assert.match(text, /Overnight research and self-improvement/);
    assert.match(text, /AI agents with browser automation/);
    assert.match(text, /awaiting approval/i);
    assert.doesNotMatch(text, new RegExp('A' + 'TLAS', 'i'));
  });

  it('renders overnight research findings and sources when the saved research report exists', () => {
    const built = buildMorningReport({
      date: '2026-04-11',
      events: [
        makeEvent({
          stage: 'operations',
          phase: 'overnight-research',
          reason: 'researched 1 topic using SearXNG',
        }),
      ],
      observations: [],
      now,
      researchReport: {
        date: '2026-04-11',
        source: 'searxng',
        topics: [
          {
            topic: 'free web research for AI agents',
            findings: 'SearXNG removes API credit limits; Playwright helps when result pages need interaction.',
            sources: ['https://searxng.org/'],
          },
        ],
      },
    });
    const { text, ...report } = built;

    assert.equal(text, renderReportAsText(report));
    assert.match(text, /SearXNG removes API credit limits/);
    assert.match(text, /https:\/\/searxng\.org\//);
  });
});
