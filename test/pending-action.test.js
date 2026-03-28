import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setPendingAction, getPendingAction, clearPendingAction, parseTopicSelection } from '../src/pending-action.js';

describe('pending-action', () => {
  const CHAT_JID = '120363001234567890@g.us';
  const TOPICS = [
    { number: 1, label: 'AI regulation', summary: 'Discussion about EU AI Act' },
    { number: 2, label: 'Team offsite', summary: 'Planning for May event' },
    { number: 3, label: 'Client pitch', summary: 'New client approach' },
  ];
  const TRANSCRIPT = '[10:00] Tom: I think AI regulation is...\n[10:05] James: The EU AI Act says...';

  beforeEach(() => {
    clearPendingAction(CHAT_JID);
  });

  describe('setPendingAction / getPendingAction', () => {
    it('stores and retrieves a pending action', () => {
      setPendingAction(CHAT_JID, 'critique', TOPICS, TRANSCRIPT);
      const action = getPendingAction(CHAT_JID);
      assert.ok(action);
      assert.equal(action.mode, 'critique');
      assert.equal(action.topics.length, 3);
      assert.equal(action.transcript, TRANSCRIPT);
    });

    it('returns null for unknown chat', () => {
      assert.equal(getPendingAction('unknown@g.us'), null);
    });

    it('overwrites previous action for same chat', () => {
      setPendingAction(CHAT_JID, 'critique', TOPICS, TRANSCRIPT);
      setPendingAction(CHAT_JID, 'summary', [TOPICS[0]], 'new transcript');
      const action = getPendingAction(CHAT_JID);
      assert.equal(action.mode, 'summary');
      assert.equal(action.topics.length, 1);
    });
  });

  describe('clearPendingAction', () => {
    it('removes the pending action', () => {
      setPendingAction(CHAT_JID, 'critique', TOPICS, TRANSCRIPT);
      clearPendingAction(CHAT_JID);
      assert.equal(getPendingAction(CHAT_JID), null);
    });

    it('does not throw when clearing non-existent action', () => {
      assert.doesNotThrow(() => clearPendingAction('nonexistent@g.us'));
    });
  });

  describe('expiry', () => {
    it('action has an expiresAt timestamp in the future', () => {
      setPendingAction(CHAT_JID, 'critique', TOPICS, TRANSCRIPT);
      const action = getPendingAction(CHAT_JID);
      assert.ok(action.expiresAt > Date.now());
    });
  });

  describe('parseTopicSelection', () => {
    it('parses single number', () => {
      assert.deepEqual(parseTopicSelection('1', 3), [1]);
    });

    it('parses "all"', () => {
      assert.equal(parseTopicSelection('all', 3), 'all');
    });

    it('parses "all of them"', () => {
      assert.equal(parseTopicSelection('all of them', 3), 'all');
    });

    it('parses "everything"', () => {
      assert.equal(parseTopicSelection('everything', 3), 'all');
    });

    it('parses "1 and 3"', () => {
      assert.deepEqual(parseTopicSelection('1 and 3', 3), [1, 3]);
    });

    it('parses "1, 3"', () => {
      assert.deepEqual(parseTopicSelection('1, 3', 3), [1, 3]);
    });

    it('parses "1 2 3"', () => {
      assert.deepEqual(parseTopicSelection('1 2 3', 3), [1, 2, 3]);
    });

    it('parses "1+3"', () => {
      assert.deepEqual(parseTopicSelection('1+3', 3), [1, 3]);
    });

    it('filters out-of-range numbers', () => {
      assert.deepEqual(parseTopicSelection('1 5 3', 3), [1, 3]);
    });

    it('returns null for zero', () => {
      assert.equal(parseTopicSelection('0', 3), null);
    });

    it('deduplicates', () => {
      assert.deepEqual(parseTopicSelection('1 1 2 2', 3), [1, 2]);
    });

    it('returns null for empty string', () => {
      assert.equal(parseTopicSelection('', 3), null);
    });

    it('returns null for null', () => {
      assert.equal(parseTopicSelection(null, 3), null);
    });

    it('returns null for non-numeric text', () => {
      assert.equal(parseTopicSelection('hello world', 3), null);
    });

    it('returns null when all numbers out of range', () => {
      assert.equal(parseTopicSelection('5 6 7', 3), null);
    });

    it('handles "yes" as non-selection (no numbers)', () => {
      assert.equal(parseTopicSelection('yes', 3), null);
    });

    it('sorts results', () => {
      assert.deepEqual(parseTopicSelection('3 1 2', 3), [1, 2, 3]);
    });
  });
});
