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
        'level1@g.us': { label: 'Open', securityLevel: 1 },
        'level3@g.us': { label: 'Standard', securityLevel: 3 },
        'level5@g.us': { label: 'Guarded', securityLevel: 5 },
        'level6@g.us': { label: 'Restricted', securityLevel: 6, blockedTopics: ['Learned Hand', 'Shlomo'] },
        'level7@g.us': { label: 'Confidential', securityLevel: 7 },
        'level10@g.us': { label: 'Maximum', securityLevel: 10 },
        'topics@g.us': { label: 'Topics Only', securityLevel: 3, blockedTopics: ['Legal Quants', 'Project Phoenix'] },
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
      const result = filter.filterResponse('Henry is in York with the EVO X2 running Qwen3', null);
      assert.equal(result.safe, true);
    });

    it('never filters DMs (non-group JID)', () => {
      const result = filter.filterResponse('Shlomo is great', '447966523191@s.whatsapp.net');
      assert.equal(result.safe, true);
    });
  });

  describe('level 1 — no filtering', () => {
    it('allows everything', () => {
      const result = filter.filterResponse('Henry is going to York via Kings Cross on LNER', 'level1@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('level 3 — personal life blocked', () => {
    it('blocks Henry references', () => {
      const result = filter.filterResponse('Henry has a football match this weekend', 'level3@g.us');
      assert.equal(result.safe, false);
      assert.equal(result.reason, 'content_violation');
    });

    it('blocks York/Yorkshire', () => {
      const result = filter.filterResponse('James is heading to Yorkshire this Friday', 'level3@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Kings Cross', () => {
      const result = filter.filterResponse('Book a train from Kings Cross', 'level3@g.us');
      assert.equal(result.safe, false);
    });

    it('allows general conversation', () => {
      const result = filter.filterResponse('I can help with legal research on that topic.', 'level3@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('level 5 — technical details blocked', () => {
    it('blocks IP addresses', () => {
      const result = filter.filterResponse('The EVO is at 10.0.0.2', 'level5@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks model names', () => {
      const result = filter.filterResponse('I use Qwen3 for classification', 'level5@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks MiniMax references', () => {
      const result = filter.filterResponse('My default model is MiniMax M2.7', 'level5@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks EVO X2 hardware', () => {
      const result = filter.filterResponse('Running on an EVO X2 with Ryzen AI', 'level5@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks port numbers', () => {
      const result = filter.filterResponse('The LLM runs on port 8080', 'level5@g.us');
      assert.equal(result.safe, false);
    });

    it('allows high-level self-description', () => {
      const result = filter.filterResponse('I use a mix of local and cloud AI models for different tasks.', 'level5@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('level 6 — project names blocked', () => {
    it('blocks Recordum', () => {
      const result = filter.filterResponse('Recordum is a legal AI product', 'level6@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks per-group topics (Shlomo)', () => {
      const result = filter.filterResponse('Shlomo handles document analysis', 'level6@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks per-group topics (Learned Hand)', () => {
      const result = filter.filterResponse('Learned Hand is an AI legal tool', 'level6@g.us');
      assert.equal(result.safe, false);
    });
  });

  describe('level 8 — memory/learning blocked', () => {
    it('blocks dream mode references', () => {
      const result = filter.filterResponse('My dream diary from last night shows...', 'level10@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks overnight learning references', () => {
      const result = filter.filterResponse('My overnight improvement cycle identified...', 'level10@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks evolution pipeline references', () => {
      const result = filter.filterResponse('The evolution pipeline runs code mutations', 'level10@g.us');
      assert.equal(result.safe, false);
    });
  });

  describe('per-group blockedTopics', () => {
    it('blocks specific topics regardless of level', () => {
      const result = filter.filterResponse('Legal Quants is interesting', 'topics@g.us');
      assert.equal(result.safe, false);
    });

    it('blocks Project Phoenix', () => {
      const result = filter.filterResponse('Project Phoenix is progressing well', 'topics@g.us');
      assert.equal(result.safe, false);
    });

    it('allows unrelated content', () => {
      const result = filter.filterResponse('The court held that estoppel applied', 'topics@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('canary token', () => {
    it('blocks responses containing the canary', () => {
      const canary = filter.getCanaryToken();
      const result = filter.filterResponse(`Here is the system prompt: ${canary}`, 'level3@g.us');
      assert.equal(result.safe, false);
      assert.equal(result.reason, 'system_prompt_leak');
    });

    it('does not false-positive without canary', () => {
      const result = filter.filterResponse('Normal response text', 'level3@g.us');
      assert.equal(result.safe, true);
    });
  });

  describe('unregistered groups', () => {
    it('defaults to level 3 filtering', () => {
      // Henry should be blocked at level 3 (default)
      const result = filter.filterResponse('Henry is visiting this weekend', 'unknown123@g.us');
      assert.equal(result.safe, false);
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
