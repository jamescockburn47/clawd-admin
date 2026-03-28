import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

describe('topic-index', () => {
  const TOPIC_INDEX_DIR = join('data', 'topic-index');
  const CONV_LOG_DIR = join('data', 'conversation-logs');
  const TEST_JID = '120363001234567890@g.us';
  const SANITISED_JID = '120363001234567890_g_us';
  const INDEX_FILE = join(TOPIC_INDEX_DIR, `${SANITISED_JID}.jsonl`);

  let topicIndex;

  beforeEach(async () => {
    // Ensure dirs exist
    if (!existsSync(TOPIC_INDEX_DIR)) mkdirSync(TOPIC_INDEX_DIR, { recursive: true });
    if (!existsSync(CONV_LOG_DIR)) mkdirSync(CONV_LOG_DIR, { recursive: true });
    // Clean up
    try { rmSync(INDEX_FILE); } catch {}
    // Fresh import
    topicIndex = await import('../src/topic-index.js');
  });

  afterEach(() => {
    try { rmSync(INDEX_FILE); } catch {}
  });

  describe('readHistoricalTopics (via getGroupTopics)', () => {
    it('returns empty when no index file exists', async () => {
      const { historical } = await topicIndex.getGroupTopics('nonexistent@g.us', 3);
      assert.equal(historical.length, 0);
    });

    it('reads topics from index file within date range', async () => {
      const today = new Date().toISOString().split('T')[0];
      const entries = [
        { groupJid: TEST_JID, date: today, number: 1, label: 'AI Regulation', summary: 'EU stuff', participants: ['Tom'], messageCount: 10 },
        { groupJid: TEST_JID, date: today, number: 2, label: 'Team Offsite', summary: 'May event', participants: ['James'], messageCount: 8 },
      ];
      writeFileSync(INDEX_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const { historical } = await topicIndex.getGroupTopics(TEST_JID, 3);
      assert.equal(historical.length, 2);
      assert.equal(historical[0].label, 'AI Regulation');
    });

    it('filters out old topics beyond history days', async () => {
      const old = '2026-01-01';
      const recent = new Date().toISOString().split('T')[0];
      const entries = [
        { groupJid: TEST_JID, date: old, number: 1, label: 'Old Topic', summary: 'ancient', participants: [], messageCount: 5 },
        { groupJid: TEST_JID, date: recent, number: 1, label: 'Recent Topic', summary: 'fresh', participants: [], messageCount: 5 },
      ];
      writeFileSync(INDEX_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      const { historical } = await topicIndex.getGroupTopics(TEST_JID, 3);
      assert.equal(historical.length, 1);
      assert.equal(historical[0].label, 'Recent Topic');
    });
  });

  describe('formatTopicsForSelection', () => {
    it('formats today and historical topics with continuous numbering', () => {
      const today = [
        { groupJid: TEST_JID, date: '2026-03-28', number: 1, label: 'Live Topic', summary: 'ongoing' },
      ];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().split('T')[0];
      const historical = [
        { groupJid: TEST_JID, date: yStr, number: 1, label: 'Yesterday Topic', summary: 'done' },
      ];

      const result = topicIndex.formatTopicsForSelection(historical, today, 'critique');
      assert.ok(result.includes('*1.*'));
      assert.ok(result.includes('Live Topic'));
      assert.ok(result.includes('*2.*'));
      assert.ok(result.includes('Yesterday Topic'));
      assert.ok(result.includes('critique'));
    });

    it('returns fallback message when no topics', () => {
      const result = topicIndex.formatTopicsForSelection([], [], 'summary');
      assert.ok(result.includes('Not enough'));
    });
  });

  describe('pruneTopicIndex', () => {
    it('removes entries older than maxDays', () => {
      const old = '2025-01-01';
      const recent = new Date().toISOString().split('T')[0];
      const entries = [
        { groupJid: TEST_JID, date: old, number: 1, label: 'Old', summary: '' },
        { groupJid: TEST_JID, date: recent, number: 1, label: 'Recent', summary: '' },
      ];
      writeFileSync(INDEX_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

      topicIndex.pruneTopicIndex(30);

      const content = readFileSync(INDEX_FILE, 'utf-8');
      assert.ok(!content.includes('Old'));
      assert.ok(content.includes('Recent'));
    });
  });
});
