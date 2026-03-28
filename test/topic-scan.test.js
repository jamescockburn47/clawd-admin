import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  getRecentGroupMessages,
  formatTranscript,
  buildSegmentationPrompt,
  parseTopicList,
  formatTopicSelection,
} from '../src/topic-scan.js';

describe('topic-scan', () => {
  const CONV_LOG_DIR = join('data', 'conversation-logs');
  const TEST_JID = '120363001234567890@g.us';
  const SANITISED = '120363001234567890_g_us';

  describe('formatTranscript', () => {
    it('formats messages with timestamps and sender names', () => {
      const messages = [
        { timestamp: '2026-03-27T10:00:00Z', sender: 'Tom', text: 'Hello', isBot: false },
        { timestamp: '2026-03-27T10:05:00Z', sender: 'James', text: 'Hi there', isBot: false },
      ];
      const result = formatTranscript(messages);
      assert.ok(result.includes('Tom: Hello'));
      assert.ok(result.includes('James: Hi there'));
    });

    it('uses "Clawd" for bot messages', () => {
      const messages = [
        { timestamp: '2026-03-27T10:00:00Z', sender: 'Clawd', text: 'I think...', isBot: true },
      ];
      const result = formatTranscript(messages);
      assert.ok(result.includes('Clawd: I think...'));
    });

    it('handles missing timestamps gracefully', () => {
      const messages = [{ sender: 'Tom', text: 'No timestamp', isBot: false }];
      const result = formatTranscript(messages);
      assert.ok(result.includes('Tom: No timestamp'));
    });
  });

  describe('buildSegmentationPrompt', () => {
    it('includes the transcript in the prompt', () => {
      const transcript = '[10:00] Tom: Test message';
      const result = buildSegmentationPrompt(transcript);
      assert.ok(result.includes(transcript));
    });

    it('instructs numbered list format', () => {
      const result = buildSegmentationPrompt('test');
      assert.ok(result.includes('numbered list'));
    });
  });

  describe('parseTopicList', () => {
    it('parses standard numbered list', () => {
      const response = '1. AI Regulation — Discussion about EU AI Act\n2. Team Offsite — Planning for May';
      const topics = parseTopicList(response);
      assert.equal(topics.length, 2);
      assert.equal(topics[0].number, 1);
      assert.equal(topics[0].label, 'AI Regulation');
      assert.equal(topics[0].summary, 'Discussion about EU AI Act');
      assert.equal(topics[1].number, 2);
      assert.equal(topics[1].label, 'Team Offsite');
    });

    it('handles topics without summaries', () => {
      const response = '1. AI Regulation\n2. Team Offsite';
      const topics = parseTopicList(response);
      assert.equal(topics.length, 2);
      assert.equal(topics[0].summary, '');
    });

    it('handles en-dash and hyphen separators', () => {
      const response = '1. AI Regulation – Discussion\n2. Team Offsite - Planning';
      const topics = parseTopicList(response);
      assert.equal(topics.length, 2);
      assert.equal(topics[0].summary, 'Discussion');
      assert.equal(topics[1].summary, 'Planning');
    });

    it('skips blank lines and non-matching lines', () => {
      const response = 'Here are the topics:\n\n1. AI Regulation — Stuff\n\nSome extra text\n2. Team Offsite — Things';
      const topics = parseTopicList(response);
      assert.equal(topics.length, 2);
    });

    it('returns empty array for empty input', () => {
      assert.deepEqual(parseTopicList(''), []);
    });

    it('returns empty array for non-list text', () => {
      assert.deepEqual(parseTopicList('I could not identify any topics.'), []);
    });
  });

  describe('formatTopicSelection', () => {
    const topics = [
      { number: 1, label: 'AI Regulation', summary: 'EU AI Act debate' },
      { number: 2, label: 'Team Offsite', summary: 'May planning' },
      { number: 3, label: 'Client Pitch', summary: '' },
    ];

    it('formats topics with bold numbers for WhatsApp', () => {
      const result = formatTopicSelection(topics, 'critique');
      assert.ok(result.includes('*1.*'));
      assert.ok(result.includes('AI Regulation'));
      assert.ok(result.includes('EU AI Act debate'));
    });

    it('uses correct mode label for critique', () => {
      const result = formatTopicSelection(topics, 'critique');
      assert.ok(result.includes('critique'));
    });

    it('uses correct mode label for summary', () => {
      const result = formatTopicSelection(topics, 'summary');
      assert.ok(result.includes('summarise'));
    });

    it('shows topic count', () => {
      const result = formatTopicSelection(topics, 'critique');
      assert.ok(result.includes('3 topics'));
    });

    it('handles single topic correctly', () => {
      const result = formatTopicSelection([topics[0]], 'summary');
      assert.ok(result.includes('1 topic'));
      assert.ok(result.includes('one'));
    });

    it('handles empty topics', () => {
      const result = formatTopicSelection([], 'critique');
      assert.ok(result.includes("couldn't identify"));
    });

    it('omits summary dash when summary is empty', () => {
      const result = formatTopicSelection([topics[2]], 'critique');
      assert.ok(result.includes('Client Pitch'));
      // Should not have a trailing " — "
      assert.ok(!result.includes('Client Pitch —'));
    });
  });

  describe('getRecentGroupMessages', () => {
    const today = new Date().toISOString().split('T')[0];
    const testFile = join(CONV_LOG_DIR, `${today}_${SANITISED}.jsonl`);

    beforeEach(() => {
      if (!existsSync(CONV_LOG_DIR)) mkdirSync(CONV_LOG_DIR, { recursive: true });
      const lines = [
        JSON.stringify({ timestamp: '2026-03-27T10:00:00Z', sender: 'Tom', text: 'First message', isBot: false }),
        JSON.stringify({ timestamp: '2026-03-27T10:01:00Z', sender: 'James', text: 'Second message', isBot: false }),
        JSON.stringify({ timestamp: '2026-03-27T10:02:00Z', sender: 'Clawd', text: 'Bot reply', isBot: true }),
      ];
      writeFileSync(testFile, lines.join('\n') + '\n');
    });

    afterEach(() => {
      try { rmSync(testFile); } catch {}
    });

    it('reads messages from today log', () => {
      const msgs = getRecentGroupMessages(TEST_JID, 50);
      assert.ok(msgs.length >= 3);
      assert.equal(msgs[msgs.length - 1].sender, 'Clawd');
    });

    it('respects count limit', () => {
      const msgs = getRecentGroupMessages(TEST_JID, 2);
      assert.equal(msgs.length, 2);
    });

    it('returns empty array for unknown group', () => {
      const msgs = getRecentGroupMessages('unknown@g.us', 50);
      assert.equal(msgs.length, 0);
    });

    it('handles malformed JSONL lines gracefully', () => {
      writeFileSync(testFile, '{"valid": true}\nnot json\n{"also": "valid"}\n');
      const msgs = getRecentGroupMessages(TEST_JID, 50);
      assert.equal(msgs.length, 2);
    });
  });
});
