// test/router.test.js — Router classification: keywords, complexity, write intent, tool routing
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let classifyByKeywords, detectsWriteIntent,
  getToolsForCategory, needsMemories, mustUseClaude,
  CATEGORY, READ_SAFE_TOOLS, WRITE_DANGEROUS_TOOLS;

async function loadModules() {
  const mod = await import('../src/router.js');
  ({ classifyByKeywords, detectsWriteIntent,
    getToolsForCategory, needsMemories, mustUseClaude,
    CATEGORY, READ_SAFE_TOOLS, WRITE_DANGEROUS_TOOLS } = mod);
}

describe('classifyByKeywords', () => {
  beforeEach(async () => {
    if (!classifyByKeywords) await loadModules();
  });

  // Calendar
  it('classifies calendar queries', () => {
    assert.equal(classifyByKeywords("what's on my calendar"), 'calendar');
    assert.equal(classifyByKeywords('check my diary'), 'calendar');
    assert.equal(classifyByKeywords('free time on Thursday'), 'calendar');
  });

  // Task
  it('classifies todo/task queries', () => {
    assert.equal(classifyByKeywords('add to my todo list'), 'task');
    assert.equal(classifyByKeywords('remind me to buy milk'), 'task');
    assert.equal(classifyByKeywords('/todo get bread'), 'task');
  });

  // Travel
  it('classifies travel queries', () => {
    assert.equal(classifyByKeywords('trains to York tomorrow'), 'travel');
    assert.equal(classifyByKeywords('hotel near Kings Cross'), 'travel');
    assert.equal(classifyByKeywords('departures from London'), 'travel');
  });

  // Email
  it('classifies email queries', () => {
    assert.equal(classifyByKeywords('check my email'), 'email');
    assert.equal(classifyByKeywords('search my inbox'), 'email');
  });

  // System
  it('classifies system queries', () => {
    assert.equal(classifyByKeywords('system status'), 'system');
    assert.equal(classifyByKeywords('what services are running'), 'system');
  });

  // Returns null for ambiguous
  it('returns null for ambiguous messages', () => {
    assert.equal(classifyByKeywords('hello how are you'), null);
    assert.equal(classifyByKeywords('what do you think about AI'), null);
  });

  // Evolution/planning keywords
  it('classifies self-coding requests as planning', () => {
    assert.equal(classifyByKeywords('evolution task fix the classifier'), 'planning');
    assert.equal(classifyByKeywords('self program a new feature'), 'planning');
  });
});

describe('detectsWriteIntent', () => {
  beforeEach(async () => {
    if (!detectsWriteIntent) await loadModules();
  });

  it('detects calendar write intent', () => {
    assert.equal(detectsWriteIntent('book a meeting for Friday'), true);
    assert.equal(detectsWriteIntent('schedule an event tomorrow'), true);
    assert.equal(detectsWriteIntent('create a calendar event'), true);
  });

  it('detects email write intent', () => {
    assert.equal(detectsWriteIntent('send an email to John'), true);
    assert.equal(detectsWriteIntent('draft an email reply'), true);
    assert.equal(detectsWriteIntent('compose an email'), true);
  });

  it('does not flag read queries', () => {
    assert.equal(detectsWriteIntent("what's on my calendar"), false);
    assert.equal(detectsWriteIntent('check my email'), false);
    assert.equal(detectsWriteIntent('trains to York'), false);
  });
});

describe('getToolsForCategory', () => {
  beforeEach(async () => {
    if (!getToolsForCategory) await loadModules();
  });

  it('always includes web search tools', () => {
    const mockTools = [
      { name: 'web_search' },
      { name: 'web_fetch' },
      { name: 'calendar_list' },
      { name: 'gmail_search' },
    ];
    const result = getToolsForCategory('calendar', mockTools);
    const names = result.map(t => t.name);
    assert.ok(names.includes('web_search'), 'should always include web_search');
  });

  it('planning category gets all tools', () => {
    const mockTools = [
      { name: 'web_search' },
      { name: 'calendar_list' },
      { name: 'gmail_search' },
      { name: 'todo_add' },
    ];
    const result = getToolsForCategory('planning', mockTools);
    assert.equal(result.length, mockTools.length);
  });
});

describe('needsMemories', () => {
  beforeEach(async () => {
    if (!needsMemories) await loadModules();
  });

  it('returns true for categories needing memory', () => {
    assert.equal(needsMemories('travel'), true);
    assert.equal(needsMemories('recall'), true);
    assert.equal(needsMemories('planning'), true);
    assert.equal(needsMemories('system'), true);
  });

  it('returns false for simple categories', () => {
    assert.equal(needsMemories('task'), false);
    assert.equal(needsMemories('calendar'), false);
  });
});

describe('tool safety sets', () => {
  beforeEach(async () => {
    if (!READ_SAFE_TOOLS) await loadModules();
  });

  it('READ_SAFE_TOOLS and WRITE_DANGEROUS_TOOLS have no overlap', () => {
    for (const tool of READ_SAFE_TOOLS) {
      assert.ok(!WRITE_DANGEROUS_TOOLS.has(tool),
        `${tool} should not be in both safe and dangerous sets`);
    }
  });

  it('write-dangerous tools include mutation operations', () => {
    // These should be gated behind Claude (not EVO)
    const expectedDangerous = ['gmail_draft', 'gmail_confirm_send',
      'calendar_create_event', 'calendar_update_event'];
    for (const tool of expectedDangerous) {
      assert.ok(WRITE_DANGEROUS_TOOLS.has(tool),
        `${tool} should be in WRITE_DANGEROUS_TOOLS`);
    }
  });
});

describe('CATEGORY constant', () => {
  beforeEach(async () => {
    if (!CATEGORY) await loadModules();
  });

  it('exports all expected categories', () => {
    assert.ok(CATEGORY.CALENDAR);
    assert.ok(CATEGORY.TASK);
    assert.ok(CATEGORY.TRAVEL);
    assert.ok(CATEGORY.EMAIL);
    assert.ok(CATEGORY.PLANNING);
    assert.ok(CATEGORY.CONVERSATIONAL);
    assert.ok(CATEGORY.GENERAL_KNOWLEDGE);
    assert.ok(CATEGORY.SYSTEM);
  });
});
