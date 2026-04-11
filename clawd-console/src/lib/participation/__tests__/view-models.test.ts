import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  OvernightEvent,
  ParticipationDecision,
  ParticipationGroupSummary,
} from '@/lib/types';
import {
  buildGroupCardModel,
  buildInstructionStackRows,
  buildParticipationMissionSummary,
  deriveParticipationMissionInputs,
  filterParticipationLearningEvents,
  formatDecisionHighlights,
  formatDurationMs,
  getMemoryLensTabs,
  memoryMatchesLens,
} from '../view-models.ts';

const GROUP_SUMMARY: ParticipationGroupSummary = {
  chatJid: 'group-1@g.us',
  groupLabel: 'LQCore',
  groupMode: 'open',
  posture: 'rare_high_confidence',
  researchEnabled: true,
  memoryRecallEnabled: true,
  maxUnsolicitedPerHour: 2,
  followUpWindowMs: 180_000,
  cooldownMs: 60_000,
};

const DECISIONS: ParticipationDecision[] = [
  {
    timestamp: '2026-04-11T10:05:00.000Z',
    chatJid: 'group-1@g.us',
    shouldIntervene: false,
    interventionType: null,
    reason: 'No marginal value yet.',
    confidence: 0.41,
    replyTarget: null,
    followUpWindowOpen: false,
    followUpTurnIndex: null,
    profilePosture: 'rare_high_confidence',
    plannedRole: null,
  },
  {
    timestamp: '2026-04-11T10:10:00.000Z',
    chatJid: 'group-2@g.us',
    shouldIntervene: true,
    interventionType: 'correction',
    reason: 'Wrong group.',
    confidence: 0.93,
    replyTarget: null,
    followUpWindowOpen: true,
    followUpTurnIndex: 1,
    profilePosture: 'active_participant',
    plannedRole: 'correction',
  },
  {
    timestamp: '2026-04-11T10:15:00.000Z',
    chatJid: 'group-1@g.us',
    shouldIntervene: true,
    interventionType: 'synthesis',
    reason: 'Useful summary.',
    confidence: 0.82,
    replyTarget: null,
    followUpWindowOpen: true,
    followUpTurnIndex: 1,
    profilePosture: 'rare_high_confidence',
    plannedRole: 'synthesis',
  },
  {
    timestamp: '2026-04-11T10:20:00.000Z',
    chatJid: 'group-1@g.us',
    shouldIntervene: true,
    interventionType: 'challenge',
    reason: 'High-confidence challenge.',
    confidence: 0.89,
    replyTarget: null,
    followUpWindowOpen: true,
    followUpTurnIndex: 2,
    profilePosture: 'rare_high_confidence',
    plannedRole: 'challenge',
  },
];

function makeEvent(overrides: Partial<OvernightEvent>): OvernightEvent {
  return {
    id: 'evt',
    timestamp: '2026-04-12T03:00:00.000Z',
    stage: 'probe',
    phase: 'baseline',
    inputs: [],
    outputs: [],
    verdict: 'ok',
    reason: 'routine',
    evidence_refs: [],
    rollback_ref: null,
    budget: { opus_sessions: 0, tokens: 0 },
    ...overrides,
  };
}

test('buildInstructionStackRows orders inherited and overridden rules clearly', () => {
  const rows = buildInstructionStackRows({
    mode: 'open',
    posture: 'rare_high_confidence',
    followUpWindowMs: 180000,
  });

  assert.equal(rows[0]?.layer, 'Security/privacy restrictions');
  assert.equal(rows.some((row) => row.layer === 'Participation policy'), true);
});

test('buildGroupCardModel computes recent decision count and last intervention timestamp', () => {
  const model = buildGroupCardModel(GROUP_SUMMARY, DECISIONS);

  assert.equal(model.recentDecisionCount, 3);
  assert.equal(model.lastInterventionAt, '2026-04-11T10:20:00.000Z');
});

test('formatDecisionHighlights sorts newest-first, filters by chatJid, and respects limit', () => {
  const highlights = formatDecisionHighlights(DECISIONS, 'group-1@g.us', 2);

  assert.equal(highlights.length, 2);
  assert.deepEqual(
    highlights.map((decision) => decision.timestamp),
    ['2026-04-11T10:20:00.000Z', '2026-04-11T10:15:00.000Z']
  );
  assert.equal(highlights.every((decision) => decision.chatJid === 'group-1@g.us'), true);
});

test('formatDurationMs clamps invalid values to 0s', () => {
  assert.equal(formatDurationMs(-1), '0s');
});

test('buildParticipationMissionSummary uses proxy wording and unknown cooldown state', () => {
  const summary = buildParticipationMissionSummary({
    defaultPosture: 'rare_high_confidence',
    cooldownState: 'unknown',
    interventionRate: 0.72,
  });

  assert.match(summary, /rare_high_confidence/i);
  assert.match(summary, /intervention-rate proxy/i);
  assert.match(summary, /not yet surfaced/i);
  assert.match(summary, /72%/);
});

test('getMemoryLensTabs includes interaction history and style notes', () => {
  assert.deepEqual(getMemoryLensTabs().slice(-2), ['interaction history', 'style notes']);
});

test('memoryMatchesLens matches identity memories and rejects non-identity for that lens', () => {
  assert.equal(
    memoryMatchesLens(
      { fact: 'James is the owner.', category: 'identity', tags: ['owner'] },
      'identity'
    ),
    true
  );
  assert.equal(
    memoryMatchesLens(
      { fact: 'The system runs nightly backups.', category: 'system', tags: ['ops'] },
      'identity'
    ),
    false
  );
});

test('memoryMatchesLens detects interaction history and style notes from heuristics', () => {
  assert.equal(
    memoryMatchesLens(
      {
        fact: 'In the WhatsApp group thread, MG prefers short replies.',
        category: 'general',
        tags: ['conversation'],
      },
      'interaction history'
    ),
    true
  );
  assert.equal(
    memoryMatchesLens(
      { fact: 'Prefers a calm tone of voice.', category: 'general', tags: ['tone'] },
      'style notes'
    ),
    true
  );
});

test('memoryMatchesLens falls back to pass-through for unknown lens labels', () => {
  assert.equal(
    memoryMatchesLens(
      { fact: 'Any memory should pass unknown lenses.', category: 'general', tags: [] },
      'unmapped lens'
    ),
    true
  );
});

test('filterParticipationLearningEvents matches participation events by phase', () => {
  const events = [
    makeEvent({ id: 'phase-match', phase: 'group participation replay' }),
    makeEvent({ id: 'skip', phase: 'trace digest' }),
  ];

  assert.deepEqual(
    filterParticipationLearningEvents(events).map((event) => event.id),
    ['phase-match']
  );
});

test('filterParticipationLearningEvents matches by reason, inputs, and outputs', () => {
  const events = [
    makeEvent({ id: 'reason-match', reason: 'ambient intervention looked useful' }),
    makeEvent({ id: 'input-match', inputs: ['follow-up window check'] }),
    makeEvent({ id: 'output-match', outputs: ['unsolicited reply held back'] }),
    makeEvent({ id: 'no-match', reason: 'routine maintenance' }),
  ];

  assert.deepEqual(
    filterParticipationLearningEvents(events).map((event) => event.id),
    ['reason-match', 'input-match', 'output-match']
  );
});

test('deriveParticipationMissionInputs defaults posture for empty groups and zero intervention rate', () => {
  assert.deepEqual(deriveParticipationMissionInputs([], []), {
    defaultPosture: 'rare_high_confidence',
    cooldownState: 'unknown',
    interventionRate: 0,
  });
});

test('deriveParticipationMissionInputs uses dominant posture and recent intervention rate', () => {
  const inputs = deriveParticipationMissionInputs(
    [
      GROUP_SUMMARY,
      { ...GROUP_SUMMARY, chatJid: 'group-2@g.us', posture: 'active_participant' },
      { ...GROUP_SUMMARY, chatJid: 'group-3@g.us', posture: 'active_participant' },
    ],
    DECISIONS
  );

  assert.equal(inputs.defaultPosture, 'active_participant');
  assert.equal(inputs.cooldownState, 'unknown');
  assert.equal(inputs.interventionRate, 0.75);
});
