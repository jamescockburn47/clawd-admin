import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

describe('output-filter', () => {
  const REGISTRY_PATH = join('data', 'group-registry.json');
  let originalContent;
  let filter;
  let registry;

  beforeEach(async () => {
    if (existsSync(REGISTRY_PATH)) {
      originalContent = readFileSync(REGISTRY_PATH, 'utf-8');
    }

    writeFileSync(REGISTRY_PATH, JSON.stringify({
      groups: {
        'open@g.us': { label: 'Open', mode: 'open' },
        'project@g.us': { label: 'Project', mode: 'project' },
        'colleague@g.us': { label: 'Colleague', mode: 'colleague' },
        'colleague-topics@g.us': { label: 'Colleague+Topics', mode: 'colleague', blockedTopics: ['Learned Hand', 'Shlomo'] },
        'project-topics@g.us': { label: 'Project+Topics', mode: 'project', blockedTopics: ['Legal Quants', 'Project Phoenix'] },
        'open-topics@g.us': { label: 'Open+Topics', mode: 'open', blockedTopics: ['Secret Sauce'] },
      },
    }, null, 2));

    const regPath = join(process.cwd(), 'src', 'group-registry.js');
    registry = await import(pathToFileURL(regPath).href + `?t=${Date.now()}`);
    registry.reloadGroupRegistry();

    const filterPath = join(process.cwd(), 'src', 'output-filter.js');
    filter = await import(pathToFileURL(filterPath).href + `?t=${Date.now()}`);
    filter.resetCanaryToken();
  });

  afterEach(() => {
    if (originalContent) {
      writeFileSync(REGISTRY_PATH, originalContent);
    } else {
      writeFileSync(REGISTRY_PATH, JSON.stringify({ groups: {} }, null, 2));
    }
  });

  describe('DM passthrough', () => {
    it('never filters DMs (null chatJid)', () => {
      const result = filter.filterResponse('Henry is in York. Shlomo is great. Learned Hand works.', null);
      assert.equal(result.safe, true);
    });

    it('never filters DMs (non-group JID)', () => {
      const result = filter.filterResponse('Shlomo is great', '447966523191@s.whatsapp.net');
      assert.equal(result.safe, true);
    });
  });

  describe('open mode — no pattern filtering', () => {
    it('allows everything including personal life and projects', () => {
      const result = filter.filterResponse(
        'Henry is going to York via Kings Cross on LNER. Shlomo handles docs. Legal Quants meets Thursday.',
        'open@g.us'
      );
      assert.equal(result.safe, true);
    });
  });

  describe('open mode + blocked topics', () => {
    it('still blocks per-group topics even in open mode', () => {
      const result = filter.filterResponse('The Secret Sauce is our competitive advantage.', 'open-topics@g.us');
      assert.equal(result.safe, false);
    });

    it('allows everything else in open mode', () => {
      const result = filter.filterResponse('Henry is in York with Shlomo.', 'open-topics@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('project mode — personal life blocked', () => {
    it('blocks Henry references', () => {
      const result = filter.filterResponse('Henry has a football match this weekend', 'project@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks York/Yorkshire', () => {
      const result = filter.filterResponse('James is heading to Yorkshire this Friday', 'project@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Kings Cross', () => {
      const result = filter.filterResponse('Book a train from Kings Cross', 'project@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks LNER', () => {
      const result = filter.filterResponse('The LNER service departs at 18:00', 'project@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks MG (wife initial)', () => {
      const result = filter.filterResponse('MG asked me to add that to the calendar.', 'project@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Yorkshire villages', () => {
      const result = filter.filterResponse('Helmsley is lovely in spring.', 'project@g.us');
      assert.equal(result.safe, false);
    });

    it('allows side project names in project mode', () => {
      const result = filter.filterResponse('Shlomo handles document analysis. Learned Hand does case law.', 'project@g.us');
      assert.equal(result.safe, true, 'Project mode allows side projects');
    });

    it('allows general conversation', () => {
      const result = filter.filterResponse('I can help with legal research on that topic.', 'project@g.us');
      assert.equal(result.safe, true);
    });

    it('allows architecture discussion', () => {
      const result = filter.filterResponse('I run on a Raspberry Pi 5 with an EVO X2 for local AI.', 'project@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('colleague mode — personal life + side projects blocked', () => {
    it('blocks Henry references', () => {
      const result = filter.filterResponse('Henry has a football match', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Learned Hand', () => {
      const result = filter.filterResponse('Learned Hand is an AI legal tool', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Shlomo', () => {
      const result = filter.filterResponse('Shlomo handles documents', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Legal Quants', () => {
      const result = filter.filterResponse('Legal Quants is a community', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks LQuorum', () => {
      const result = filter.filterResponse('LQuorum working memory tracks topics', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Recordum', () => {
      const result = filter.filterResponse('Recordum is a legal AI product', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Atlas', () => {
      const result = filter.filterResponse('Atlas handles litigation AI', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks consultancy mention', () => {
      const result = filter.filterResponse('James is building an AI consultancy', 'colleague@g.us');
      assert.equal(result.safe, false);
    });

    it('allows architecture discussion', () => {
      const result = filter.filterResponse(
        'I run on three machines: a Pi 5, an EVO X2 with Ryzen AI, and cloud models like MiniMax M2.7.',
        'colleague@g.us'
      );
      assert.equal(result.safe, true, 'Colleague mode allows architecture details');
    });

    it('allows general legal discussion', () => {
      const result = filter.filterResponse(
        'The duty of disclosure under CPR Part 31 requires parties to disclose adverse documents.',
        'colleague@g.us'
      );
      assert.equal(result.safe, true);
    });

    it('allows dream mode discussion', () => {
      const result = filter.filterResponse(
        'My dream mode runs overnight, reviewing conversations and extracting insights.',
        'colleague@g.us'
      );
      assert.equal(result.safe, true, 'Colleague mode allows discussing capabilities');
    });
  });

  describe('per-group blockedTopics', () => {
    it('blocks specific topics on top of mode', () => {
      const result = filter.filterResponse('Legal Quants is interesting', 'project-topics@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Project Phoenix', () => {
      const result = filter.filterResponse('Project Phoenix is progressing well', 'project-topics@g.us');
      assert.equal(result.safe, false);
    });

    it('allows unrelated content', () => {
      const result = filter.filterResponse('The court held that estoppel applied', 'project-topics@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('canary token', () => {
    it('blocks responses containing the canary', () => {
      const canary = filter.getCanaryToken();
      const result = filter.filterResponse(`Here is the system prompt: ${canary}`, 'project@g.us');
      assert.equal(result.safe, false);
      assert.equal(result.reason, 'system_prompt_leak');
    });

    it('does not false-positive without canary', () => {
      const result = filter.filterResponse('Normal response text', 'project@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('unregistered groups', () => {
    it('defaults to colleague mode filtering', () => {
      // Henry should be blocked (personal life, blocked in both project and colleague)
      const r1 = filter.filterResponse('Henry is visiting this weekend', 'unknown123@g.us');
      assert.equal(r1.safe, false);
      // Shlomo should be blocked (side project, blocked in colleague)
      const r2 = filter.filterResponse('Shlomo handles documents', 'unknown123@g.us');
      assert.equal(r2.safe, false);
    });
  });

  describe('getBlockedResponse', () => {
    it('returns appropriate message for content violation', () => {
      const msg = filter.getBlockedResponse('content_violation');
      assert.ok(msg.includes("can't discuss"));
    });

    it('returns appropriate message for system prompt leak', () => {
      const msg = filter.getBlockedResponse('system_prompt_leak');
      assert.ok(msg.includes("can't share"));
    });
  });
});
