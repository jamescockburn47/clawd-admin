/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearConversationStateForTest,
  getConversationState,
  openFollowUpWindow,
} from '../conversation-state.js';
import {
  getDefaultFollowUpWindowMs,
  registerFollowUpTurn,
  shouldContinueFollowUp,
} from '../engagement-service.js';
import { MAX_FOLLOW_UP_TURNS_PER_WINDOW } from '../constants.js';
import { quotedReplyTarget } from '../reply-target.js';

test('shouldContinueFollowUp is false when no follow-up window is open', () => {
  clearConversationStateForTest();
  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 1000,
      directlyRepliesToClint: true,
      mentionsClint: true,
    }),
    false,
  );
});

test('shouldContinueFollowUp honours expiry and clears the window', () => {
  clearConversationStateForTest();
  openFollowUpWindow({
    chatJid: 'g@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: quotedReplyTarget('human-1', 'James'),
    expiresAt: 500,
  });

  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 501,
      directlyRepliesToClint: true,
      mentionsClint: false,
    }),
    false,
  );
  assert.equal(getConversationState('g@g.us').followUpWindow, null);
});

test('shouldContinueFollowUp allows continuation when in window and reply or mention', () => {
  clearConversationStateForTest();
  openFollowUpWindow({
    chatJid: 'g@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: null,
    expiresAt: 10_000,
  });

  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 100,
      directlyRepliesToClint: true,
      mentionsClint: false,
    }),
    true,
  );

  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 200,
      directlyRepliesToClint: false,
      mentionsClint: true,
    }),
    true,
  );

  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 300,
      directlyRepliesToClint: false,
      mentionsClint: false,
    }),
    false,
  );
});

test('registerFollowUpTurn increments follow-up turnIndex while open', () => {
  clearConversationStateForTest();
  openFollowUpWindow({
    chatJid: 'g@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: null,
    expiresAt: 10_000,
  });
  assert.equal(getConversationState('g@g.us').followUpWindow?.turnIndex, 0);
  registerFollowUpTurn('g@g.us');
  registerFollowUpTurn('g@g.us');
  assert.equal(getConversationState('g@g.us').followUpWindow?.turnIndex, 2);
});

test('shouldContinueFollowUp closes the window after the follow-up turn cap', () => {
  clearConversationStateForTest();
  openFollowUpWindow({
    chatJid: 'g@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: null,
    expiresAt: 10_000,
  });

  for (let i = 0; i < MAX_FOLLOW_UP_TURNS_PER_WINDOW; i += 1) {
    registerFollowUpTurn('g@g.us');
  }

  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 100,
      directlyRepliesToClint: true,
      mentionsClint: false,
    }),
    false,
  );
  assert.equal(getConversationState('g@g.us').followUpWindow, null);
});

test('getDefaultFollowUpWindowMs matches participation defaults', () => {
  assert.equal(getDefaultFollowUpWindowMs(), 300_000);
});

test('shouldContinueFollowUp accepts same-sender continuation without @mention or native reply', () => {
  clearConversationStateForTest();
  openFollowUpWindow({
    chatJid: 'g@g.us',
    sourceMessageId: 'bot-1',
    replyTarget: null,
    lastRepliedSenderJid: 'peter@lid',
    expiresAt: 10_000,
  });

  // Same sender as the one Clint just replied to — continuation allowed.
  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 100,
      directlyRepliesToClint: false,
      mentionsClint: false,
      senderJid: 'peter@lid',
    }),
    true,
  );

  // Different sender with no explicit signal — not allowed.
  assert.equal(
    shouldContinueFollowUp({
      chatJid: 'g@g.us',
      now: 200,
      directlyRepliesToClint: false,
      mentionsClint: false,
      senderJid: 'charlotte@lid',
    }),
    false,
  );
});
