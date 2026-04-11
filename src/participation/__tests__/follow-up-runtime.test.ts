/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearConversationStateForTest,
  getConversationState,
  openFollowUpWindow,
} from '../conversation-state.js';
import { applyProductionFollowUpTurn } from '../follow-up-runtime.js';

test('applyProductionFollowUpTurn increments turnIndex for a real inbound follow-up reply', () => {
  clearConversationStateForTest();
  openFollowUpWindow({
    chatJid: 'g@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: null,
    expiresAt: 10_000,
  });

  const result = applyProductionFollowUpTurn({
    chatJid: 'g@g.us',
    isGroup: true,
    isFromMe: false,
    now: 100,
    directlyRepliesToClint: true,
    mentionsClint: false,
  });

  assert.equal(result.inFollowUpExchange, true);
  assert.equal(result.followUpWindowOpen, true);
  assert.equal(result.followUpTurnIndex, 1);
  assert.equal(getConversationState('g@g.us').followUpWindow?.turnIndex, 1);
});
