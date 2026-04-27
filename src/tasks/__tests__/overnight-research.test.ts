import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryEvents } from '../../overnight/events.js';
import { runOvernightResearch } from '../overnight-research.js';

describe('tasks/overnight-research.runOvernightResearch', () => {
  let tmpRoot: string;
  let logDir: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'overnight-research-'));
    logDir = join(tmpRoot, 'conversation-logs');
    overnightDir = join(tmpRoot, 'overnight');
    mkdirSync(logDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('researches up to three conversation-derived topics using search and fetch', async () => {
    writeFileSync(
      join(logDir, '2026-04-27_group.jsonl'),
      [
        JSON.stringify({ sender: 'James', text: 'We need better free browser research for AI agents without API credits.', isBot: false }),
        JSON.stringify({ sender: 'MG', text: 'Also check how SearXNG compares with Playwright for deep web research.', isBot: false }),
      ].join('\n'),
      'utf8',
    );

    const result = await runOvernightResearch({
      date: '2026-04-28',
      logDir,
      overnightDir,
      chooseTopics: async () => [
        'free browser research for AI agents',
        'SearXNG versus Playwright',
      ],
      search: async ({ query }) => [
        `1. Result for ${query}`,
        `   https://example.com/${encodeURIComponent(query)}`,
        '   useful snippet',
      ].join('\n'),
      fetchPage: async ({ url }) => `Fetched content from ${url}`,
      chat: async () => 'Finding: SearXNG is the no-credit search path; Playwright is useful for page interaction.',
    });

    assert.equal(result.topics.length, 2);
    assert.equal(result.topics[0]?.sources.length, 1);
    assert.match(result.topics[0]?.findings ?? '', /SearXNG/);

    const saved = JSON.parse(
      await readFile(join(overnightDir, 'research-2026-04-28.json'), 'utf8'),
    );
    assert.equal(saved.source, 'searxng');
    assert.equal(saved.topics.length, 2);

    const events = await queryEvents({ date: '2026-04-28', overnightDir });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.stage, 'operations');
    assert.equal(events[0]?.phase, 'overnight-research');
    assert.match(events[0]?.reason ?? '', /using SearXNG/);
    assert.equal(events[0]?.outputs.includes('research:free browser research for AI agents'), true);
  });

  it('records a skipped event when there is no useful conversation text', async () => {
    const result = await runOvernightResearch({
      date: '2026-04-28',
      logDir,
      overnightDir,
      search: async () => '',
      fetchPage: async () => '',
      chat: async () => '',
    });

    assert.equal(result.topics.length, 0);
    const events = await queryEvents({ date: '2026-04-28', overnightDir });
    assert.equal(events[0]?.verdict, 'skipped');
    assert.match(events[0]?.reason ?? '', /no conversation text/i);
  });
});
