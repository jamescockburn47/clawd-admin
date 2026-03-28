import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectGroupMode, detectTopicSelection, buildExecutionPrompt } from '../src/group-modes.js';
import { setPendingAction, clearPendingAction } from '../src/pending-action.js';

describe('group-modes', () => {
  const CHAT_JID = '120363001234567890@g.us';
  const TOPICS = [
    { displayNum: 1, number: 1, label: 'AI Regulation', summary: 'EU AI Act' },
    { displayNum: 2, number: 2, label: 'Team Offsite', summary: 'May event' },
    { displayNum: 3, number: 3, label: 'Client Pitch', summary: 'New approach' },
  ];
  const TRANSCRIPT = '[10:00] Tom: The EU AI Act is...\n[10:05] James: I disagree because...';

  beforeEach(() => {
    clearPendingAction(CHAT_JID);
  });

  describe('detectGroupMode', () => {
    // Devil's advocate triggers
    it('detects "devil\'s advocate"', () => {
      const result = detectGroupMode("devil's advocate");
      assert.deepEqual(result, { mode: 'critique' });
    });

    it('detects "devils advocate" (no apostrophe)', () => {
      const result = detectGroupMode('devils advocate');
      assert.deepEqual(result, { mode: 'critique' });
    });

    it('detects "Devil\'s Advocate" (capitalised)', () => {
      const result = detectGroupMode("Devil's Advocate");
      assert.deepEqual(result, { mode: 'critique' });
    });

    it('detects devil\'s advocate with smart quotes', () => {
      const result = detectGroupMode("devil\u2019s advocate");
      assert.deepEqual(result, { mode: 'critique' });
    });

    it('detects devil\'s advocate in a longer sentence', () => {
      const result = detectGroupMode("play devil's advocate on this");
      assert.deepEqual(result, { mode: 'critique' });
    });

    // Summary triggers
    it('detects "summarise"', () => {
      const result = detectGroupMode('summarise');
      assert.deepEqual(result, { mode: 'summary' });
    });

    it('detects "summarize" (US spelling)', () => {
      const result = detectGroupMode('summarize');
      assert.deepEqual(result, { mode: 'summary' });
    });

    it('detects "summary"', () => {
      const result = detectGroupMode('summary');
      assert.deepEqual(result, { mode: 'summary' });
    });

    it('detects "recap"', () => {
      const result = detectGroupMode('recap');
      assert.deepEqual(result, { mode: 'summary' });
    });

    it('detects "catch me up"', () => {
      const result = detectGroupMode('catch me up');
      assert.deepEqual(result, { mode: 'summary' });
    });

    it('detects "what did i miss"', () => {
      const result = detectGroupMode('what did i miss');
      assert.deepEqual(result, { mode: 'summary' });
    });

    it('detects "what have i missed"', () => {
      const result = detectGroupMode('what have i missed');
      assert.deepEqual(result, { mode: 'summary' });
    });

    // Non-triggers
    it('returns null for empty string', () => {
      assert.equal(detectGroupMode(''), null);
    });

    it('returns null for null', () => {
      assert.equal(detectGroupMode(null), null);
    });

    it('returns null for unrelated text', () => {
      assert.equal(detectGroupMode('what is the weather like'), null);
    });

    // Priority: devil's advocate before summary
    it('prefers critique over summary when both present', () => {
      const result = detectGroupMode("devil's advocate and summarise this");
      assert.deepEqual(result, { mode: 'critique' });
    });
  });

  describe('detectTopicSelection', () => {
    it('returns null when no pending action', () => {
      assert.equal(detectTopicSelection('1', CHAT_JID), null);
    });

    it('detects topic selection when pending action exists', () => {
      setPendingAction(CHAT_JID, 'critique', TOPICS, TRANSCRIPT);
      const result = detectTopicSelection('1 and 3', CHAT_JID);
      assert.ok(result);
      assert.deepEqual(result.selectedTopics, [1, 3]);
      assert.equal(result.action.mode, 'critique');
    });

    it('detects "all" selection', () => {
      setPendingAction(CHAT_JID, 'summary', TOPICS, TRANSCRIPT);
      const result = detectTopicSelection('all', CHAT_JID);
      assert.ok(result);
      assert.equal(result.selectedTopics, 'all');
    });

    it('returns null for non-selection text', () => {
      setPendingAction(CHAT_JID, 'critique', TOPICS, TRANSCRIPT);
      assert.equal(detectTopicSelection('hello there', CHAT_JID), null);
    });
  });

  describe('buildExecutionPrompt', () => {
    const action = {
      mode: 'critique',
      topics: TOPICS,
      transcript: TRANSCRIPT,
    };

    it('builds critique prompt for specific topics', () => {
      const prompt = buildExecutionPrompt(action, [1, 3]);
      assert.ok(prompt.includes("Devil's Advocate"));
      assert.ok(prompt.includes('AI Regulation'));
      assert.ok(prompt.includes('Client Pitch'));
      assert.ok(!prompt.includes('Team Offsite'));
      assert.ok(prompt.includes(TRANSCRIPT));
    });

    it('builds critique prompt for all topics', () => {
      const prompt = buildExecutionPrompt(action, 'all');
      assert.ok(prompt.includes('AI Regulation'));
      assert.ok(prompt.includes('Team Offsite'));
      assert.ok(prompt.includes('Client Pitch'));
    });

    it('builds summary prompt for summary mode', () => {
      const summaryAction = { ...action, mode: 'summary' };
      const prompt = buildExecutionPrompt(summaryAction, [2]);
      assert.ok(prompt.includes('Summarise'));
      assert.ok(prompt.includes('Team Offsite'));
      assert.ok(!prompt.includes('AI Regulation'));
    });

    it('critique prompt includes framework sections', () => {
      const prompt = buildExecutionPrompt(action, 'all');
      assert.ok(prompt.includes('Key assumptions'));
      assert.ok(prompt.includes('Pre-mortem'));
      assert.ok(prompt.includes('Steelman'));
      assert.ok(prompt.includes('Blind spots'));
    });

    it('summary prompt includes attribution instruction', () => {
      const summaryAction = { ...action, mode: 'summary' };
      const prompt = buildExecutionPrompt(summaryAction, 'all');
      assert.ok(prompt.includes('Attribute'));
    });

    it('both prompts prohibit emojis', () => {
      const critiquePrompt = buildExecutionPrompt(action, 'all');
      const summaryAction = { ...action, mode: 'summary' };
      const summaryPrompt = buildExecutionPrompt(summaryAction, 'all');
      assert.ok(critiquePrompt.includes('NEVER use emojis'));
      assert.ok(summaryPrompt.includes('NEVER use emojis'));
    });
  });
});
