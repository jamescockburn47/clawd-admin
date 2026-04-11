/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ROLLING_TURNS_PER_CHAT } from '../constants.js';
import {
  recordParticipantTurn,
  openFollowUpWindow,
  getConversationState,
  clearConversationStateForTest,
} from '../conversation-state.js';

test('opening a follow-up window marks the group as in active follow-up', () => {
  clearConversationStateForTest();

  recordParticipantTurn({
    chatJid: 'lqcore@g.us',
    senderName: 'Clint',
    text: 'The missing question is whether the authority still stands after SAR changes.',
    messageId: 'bot-1',
    timestamp: 1,
    isBot: true,
  });

  openFollowUpWindow({
    chatJid: 'lqcore@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: { kind: 'quoted', messageId: 'human-1', senderName: 'James' },
    expiresAt: 181000,
  });

  const state = getConversationState('lqcore@g.us');
  assert.equal(state.followUpWindow?.open, true);
  assert.equal(state.followUpWindow?.sourceMessageId, 'bot-1');
});

test('rolling buffer drops oldest turns after the cap', () => {
  clearConversationStateForTest();
  const chatJid = 'roll@g.us';
  const firstId = 'first';
  recordParticipantTurn({
    chatJid,
    senderName: 'A',
    text: 'first',
    messageId: firstId,
    timestamp: 1,
    isBot: false,
  });
  for (let i = 0; i < MAX_ROLLING_TURNS_PER_CHAT; i += 1) {
    recordParticipantTurn({
      chatJid,
      senderName: 'B',
      text: `x${i}`,
      messageId: `m-${i}`,
      timestamp: 2 + i,
      isBot: false,
    });
  }
  const state = getConversationState(chatJid);
  assert.equal(state.turns.length, MAX_ROLLING_TURNS_PER_CHAT);
  assert.equal(state.turns[0]?.messageId, 'm-0');
  assert.notEqual(state.turns.some((t) => t.messageId === firstId), true);
});
