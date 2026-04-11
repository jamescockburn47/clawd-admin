/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendParticipationDecision,
  getRecentParticipationDecisions,
  resetParticipationLogsForTest,
} from '../log-store.js';

test('appendParticipationDecision records replyTarget and follow-up metadata', () => {
  resetParticipationLogsForTest();

  appendParticipationDecision({
    chatJid: 'lqcore@g.us',
    shouldIntervene: true,
    interventionType: 'research_injection',
    reason: 'follow_up_continuation',
    confidence: 0.84,
    replyTarget: { kind: 'quoted', messageId: 'm-1', senderName: 'James' },
    followUpWindowOpen: true,
    followUpTurnIndex: 1,
  });

  const items = getRecentParticipationDecisions(10);
  assert.equal(items[0]?.replyTarget?.messageId, 'm-1');
  assert.equal(items[0]?.followUpTurnIndex, 1);
});
