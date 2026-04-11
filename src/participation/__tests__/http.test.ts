/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildParticipationSummary,
  serializeParticipationDecisionsForApi,
} from '../http.js';
import type { ParticipationDecisionRecord } from '../log-store.js';

test('buildParticipationSummary returns console-safe fields only', () => {
  const summary = buildParticipationSummary({
    chatJid: 'lqcore@g.us',
    groupLabel: 'LQCore',
    posture: 'rare_high_confidence',
    maxUnsolicitedPerHour: 3,
    followUpWindowMs: 180000,
  });

  assert.equal(summary.chatJid, 'lqcore@g.us');
  assert.equal(summary.posture, 'rare_high_confidence');
  assert.ok(!('blockedTopicsRaw' in summary));
});

test('buildParticipationSummary fills operator-safe defaults for omitted optional fields', () => {
  const summary = buildParticipationSummary({
    chatJid: 'ops@g.us',
    groupLabel: 'Ops',
    posture: 'direct_only',
    maxUnsolicitedPerHour: 2,
    followUpWindowMs: 120000,
  });

  assert.equal(summary.groupMode, 'colleague');
  assert.equal(summary.researchEnabled, true);
  assert.equal(summary.memoryRecallEnabled, true);
  assert.equal(summary.cooldownMs, 60000);
});

test('serializeParticipationDecisionsForApi preserves operator-facing fields', () => {
  const records: ParticipationDecisionRecord[] = [
    {
      timestamp: '2026-04-11T12:00:00.000Z',
      chatJid: 'g@g.us',
      shouldIntervene: false,
      interventionType: null,
      reason: 'cooldown',
      confidence: 0.2,
      replyTarget: null,
      followUpWindowOpen: false,
      followUpTurnIndex: null,
      profilePosture: 'direct_only',
      plannedRole: null,
    },
  ];
  const { decisions } = serializeParticipationDecisionsForApi(records);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.reason, 'cooldown');
  assert.equal(decisions[0]?.profilePosture, 'direct_only');
});

test('serializeParticipationDecisionsForApi preserves a non-null replyTarget shape', () => {
  const records: ParticipationDecisionRecord[] = [
    {
      timestamp: '2026-04-11T12:05:00.000Z',
      chatJid: 'g@g.us',
      shouldIntervene: true,
      interventionType: 'follow_up',
      reason: 'active_follow_up',
      confidence: 0.91,
      replyTarget: { kind: 'quoted', messageId: 'msg-123', senderName: 'James' },
      followUpWindowOpen: true,
      followUpTurnIndex: 2,
      profilePosture: 'rare_high_confidence',
      plannedRole: 'assistant',
    },
  ];

  const { decisions } = serializeParticipationDecisionsForApi(records);
  assert.deepEqual(decisions[0]?.replyTarget, {
    kind: 'quoted',
    messageId: 'msg-123',
    senderName: 'James',
  });
});
