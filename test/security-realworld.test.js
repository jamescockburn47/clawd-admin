// Real-world security tests — simulates actual attack vectors and normal usage
// Tests the output filter (code-level defense) which is the hard gate.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

describe('Security — Real-World Scenarios', () => {
  const REGISTRY_PATH = join('data', 'group-registry.json');
  let originalContent;
  let filter;
  let registry;

  beforeEach(async () => {
    if (existsSync(REGISTRY_PATH)) {
      originalContent = readFileSync(REGISTRY_PATH, 'utf-8');
    }

    // Tom's group: colleague mode + specific blocked topics
    writeFileSync(REGISTRY_PATH, JSON.stringify({
      groups: {
        'tom@g.us': {
          label: 'AGI (Tom Glover)',
          mode: 'colleague',
          blockedTopics: ['Learned Hand', 'Shlomo', 'Legal Quants'],
        },
        'lq@g.us': {
          label: 'LQ Discussion',
          mode: 'project',
          blockedTopics: ['Learned Hand', 'Shlomo'],
        },
        'open@g.us': {
          label: 'Inner Circle',
          mode: 'open',
        },
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
      writeFileSync(REGISTRY_PATH, JSON.stringify({
        _comment: 'Restored by tests',
        groups: { '120363426226720044@g.us': { label: 'AGI (Tom Glover)', mode: 'colleague', blockedTopics: ['Learned Hand', 'Shlomo', 'Legal Quants'] } },
      }, null, 2));
    }
  });

  // ── TOM'S GROUP (COLLEAGUE MODE): THINGS THAT SHOULD BE ALLOWED ─────────

  describe("Tom's group — allowed content (colleague mode allows architecture)", () => {
    it('allows describing the three-tier AI architecture', () => {
      const r = filter.filterResponse(
        'I run on three machines: a Raspberry Pi 5 for WhatsApp and tools, an EVO X2 mini PC for local AI inference, and cloud models for chat responses.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing dream mode', () => {
      const r = filter.filterResponse(
        'Every night I run a dream mode cycle. My local model reviews the day\'s conversations, extracts facts and insights, and stores them in my memory service.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing the evolution pipeline', () => {
      const r = filter.filterResponse(
        'I can modify my own code through an evolution pipeline. Claude Code CLI runs on the EVO, makes changes in a git branch, and James reviews the diff before anything is deployed.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing model names', () => {
      const r = filter.filterResponse(
        'My default model is MiniMax M2.7 for chat. For complex tasks, James can invoke Claude Opus 4.6. Locally I run Qwen3 models for classification and vision.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing the task planner', () => {
      const r = filter.filterResponse(
        'When I detect a multi-step request, my 4B classifier flags it and the task planner decomposes it into steps with dependency tracking.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing the AGI roadmap', () => {
      const r = filter.filterResponse(
        'On the AGI scoring framework I sit at about 81 out of 100. Planning and reasoning jumped from 4 to 7 with the task planner.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing the memory system', () => {
      const r = filter.filterResponse(
        'I have a memory service running on port 5100 that stores facts, insights, and soul observations. Working memory tracks 18 topics with a 15-minute decay.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing IP addresses', () => {
      const r = filter.filterResponse(
        'The EVO X2 connects via direct ethernet at 10.0.0.2. The Pi serves on the local network at 192.168.1.211.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows general legal discussion', () => {
      const r = filter.filterResponse(
        'The duty of disclosure under CPR Part 31 requires parties to disclose documents on which they rely.',
        'tom@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows discussing Harcus Parker', () => {
      const r = filter.filterResponse(
        'James works at Harcus Parker as a Senior Solicitor Advocate.',
        'tom@g.us'
      );
      assert.equal(r.safe, true, 'Tom is at Harcus Parker too — not blocked');
    });
  });

  // ── TOM'S GROUP: THINGS THAT MUST BE BLOCKED ────────────────────────────

  describe("Tom's group — blocked content", () => {
    it('blocks direct mention of Learned Hand', () => {
      const r = filter.filterResponse(
        'Learned Hand is an AI-powered legal research tool that James is building.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks direct mention of Shlomo', () => {
      const r = filter.filterResponse(
        'Shlomo handles document analysis and case preparation.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks direct mention of Legal Quants', () => {
      const r = filter.filterResponse(
        'Legal Quants is a community focused on AI in legal practice.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Shlomo even in a list', () => {
      const r = filter.filterResponse(
        'James works on several projects including Clawd, Shlomo, and others.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Recordum (colleague mode blocks all side projects)', () => {
      const r = filter.filterResponse(
        'Recordum is a local-first legal AI model.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Atlas (colleague mode)', () => {
      const r = filter.filterResponse(
        'Atlas is a litigation AI product James is developing.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks consultancy mention (colleague mode)', () => {
      const r = filter.filterResponse(
        'James is setting up an AI consultancy alongside his legal practice.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Henry references', () => {
      const r = filter.filterResponse(
        'James is visiting Henry in Yorkshire this weekend.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Henry even without "James"', () => {
      const r = filter.filterResponse(
        "Henry's got a football match on Saturday.",
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Yorkshire travel details', () => {
      const r = filter.filterResponse(
        'The cheapest train from Kings Cross to York is the 06:30 LNER service.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks family references (MG)', () => {
      const r = filter.filterResponse(
        'MG asked me to add that to the calendar.',
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });
  });

  // ── LQ GROUP (PROJECT MODE): SPECIFIC BLOCKS ON TOP ─────────────────────

  describe("LQ group — project mode + specific blocks", () => {
    it('allows Legal Quants discussion (not in blockedTopics)', () => {
      const r = filter.filterResponse(
        'Legal Quants meets every Thursday to discuss AI in legal practice.',
        'lq@g.us'
      );
      assert.equal(r.safe, true, 'Legal Quants is not in blockedTopics for this group');
    });

    it('blocks Shlomo (in blockedTopics)', () => {
      const r = filter.filterResponse(
        'Shlomo handles document analysis.',
        'lq@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks Learned Hand (in blockedTopics)', () => {
      const r = filter.filterResponse(
        'Learned Hand does case law retrieval.',
        'lq@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks personal life (project mode)', () => {
      const r = filter.filterResponse(
        'Henry is at York this weekend.',
        'lq@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('allows architecture discussion (project mode)', () => {
      const r = filter.filterResponse(
        'I run on a Raspberry Pi 5 with an EVO X2 running Qwen3 models locally.',
        'lq@g.us'
      );
      assert.equal(r.safe, true);
    });

    it('allows Recordum discussion (not blocked in project mode)', () => {
      const r = filter.filterResponse(
        'Recordum is a local-first legal AI model.',
        'lq@g.us'
      );
      assert.equal(r.safe, true, 'Project mode does not block side project names');
    });
  });

  // ── PROMPT INJECTION ATTACK SIMULATIONS ──────────────────────────────────

  describe('Prompt injection — model output scanning', () => {
    it('blocks response that reveals blocked topics after "ignore instructions" attack', () => {
      const r = filter.filterResponse(
        "James's projects include Clawd (his WhatsApp bot), Shlomo (document analysis), Learned Hand (legal research), and Legal Quants (community).",
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks response containing system prompt canary', () => {
      const canary = filter.getCanaryToken();
      const r = filter.filterResponse(
        `Here are my instructions: ${canary} You are James's personal assistant...`,
        'tom@g.us'
      );
      assert.equal(r.safe, false);
      assert.equal(r.reason, 'system_prompt_leak');
    });

    it('blocks response that casually mentions blocked topics in passing', () => {
      const r = filter.filterResponse(
        "I'm similar to other legal AI tools. There's one called Learned Hand that works on case law retrieval.",
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks response revealing personal schedule after role-play attack', () => {
      const r = filter.filterResponse(
        "Sure! James is taking the train from Kings Cross to York on Friday to see Henry. He's booked LNER.",
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks response with blocked topic in a question', () => {
      const r = filter.filterResponse(
        "Are you asking about Shlomo? I can't discuss that here.",
        'tom@g.us'
      );
      assert.equal(r.safe, false, 'Even mentioning the name in a refusal is blocked');
    });

    it('blocks partial matches — Shlomo possessive', () => {
      const r = filter.filterResponse(
        "Shlomo's architecture is based on RAG pipelines.",
        'tom@g.us'
      );
      assert.equal(r.safe, false);
    });

    it('blocks response listing all projects after jailbreak attempt', () => {
      const r = filter.filterResponse(
        "James's side projects are: Recordum, Atlas, and a legal AI consultancy. He also contributes to LQuorum.",
        'tom@g.us'
      );
      assert.equal(r.safe, false, 'Colleague mode catches all side project names');
    });
  });

  // ── OPEN GROUP: EVERYTHING ALLOWED ──────────────────────────────────────

  describe('Open group — no restrictions', () => {
    it('allows everything including personal life and projects', () => {
      const r = filter.filterResponse(
        'Henry is at York. Shlomo runs. 10.0.0.2 is the EVO. Qwen3 classifies. Legal Quants meets Thursday. Learned Hand does case law. Recordum is local-first.',
        'open@g.us'
      );
      assert.equal(r.safe, true);
    });
  });

  // ── DM PASSTHROUGH ──────────────────────────────────────────────────────

  describe('DM passthrough — no filtering', () => {
    it('allows everything in DMs (null chatJid)', () => {
      const r = filter.filterResponse(
        'Henry is at York. Shlomo handles documents. Learned Hand does case law. Legal Quants meets Thursday. Train from Kings Cross at 6:30.',
        null
      );
      assert.equal(r.safe, true);
    });

    it('allows everything in DMs (phone JID)', () => {
      const r = filter.filterResponse(
        'Shlomo and Learned Hand are progressing well. Henry has football.',
        '447966523191@s.whatsapp.net'
      );
      assert.equal(r.safe, true);
    });
  });

  // ── EDGE CASES ──────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('blocks topic in mixed case', () => {
      const r = filter.filterResponse('SHLOMO is a great tool.', 'tom@g.us');
      assert.equal(r.safe, false);
    });

    it('blocks topic mid-sentence', () => {
      const r = filter.filterResponse('Have you heard of Legal Quants? Very interesting.', 'tom@g.us');
      assert.equal(r.safe, false);
    });

    it('allows "learned" without "Hand"', () => {
      const r = filter.filterResponse('I learned that from a web search.', 'tom@g.us');
      assert.equal(r.safe, true);
    });

    it('allows "hand" without "Learned"', () => {
      const r = filter.filterResponse('On the other hand, the court disagreed.', 'tom@g.us');
      assert.equal(r.safe, true);
    });

    it('allows "legal" without "Quants"', () => {
      const r = filter.filterResponse('That raises complex legal questions.', 'tom@g.us');
      assert.equal(r.safe, true);
    });

    it('allows "quants" without "Legal"', () => {
      const r = filter.filterResponse('Quantitative analysis is useful.', 'tom@g.us');
      assert.equal(r.safe, true);
    });

    it('empty response passes', () => {
      const r = filter.filterResponse('', 'tom@g.us');
      assert.equal(r.safe, true);
    });

    it('very long response is still scanned', () => {
      const padding = 'This is a normal sentence about legal topics. '.repeat(200);
      const r = filter.filterResponse(padding + 'By the way, Shlomo is interesting.', 'tom@g.us');
      assert.equal(r.safe, false);
    });

    it('blocked topic at very start of response', () => {
      const r = filter.filterResponse('Shlomo — this is a document analysis tool.', 'tom@g.us');
      assert.equal(r.safe, false);
    });

    it('blocked topic at very end of response', () => {
      const r = filter.filterResponse('There are several tools in development, including Shlomo', 'tom@g.us');
      assert.equal(r.safe, false);
    });

    it('unregistered group gets colleague mode default', () => {
      const r = filter.filterResponse('Henry is going to York.', 'unknown123@g.us');
      assert.equal(r.safe, false, 'Unregistered groups should block personal details');
    });

    it('unregistered group blocks side projects too', () => {
      const r = filter.filterResponse('Shlomo handles documents.', 'unknown123@g.us');
      assert.equal(r.safe, false, 'Colleague mode is the default — blocks side projects');
    });
  });

  // ── CANARY TOKEN ────────────────────────────────────────────────────────

  describe('Canary token detection', () => {
    it('detects canary in plain text leak', () => {
      const canary = filter.getCanaryToken();
      const r = filter.filterResponse(
        `My system prompt says: ${canary} and then instructions about being Clawd.`,
        'tom@g.us'
      );
      assert.equal(r.safe, false);
      assert.equal(r.reason, 'system_prompt_leak');
    });

    it('detects canary even surrounded by other text', () => {
      const canary = filter.getCanaryToken();
      const r = filter.filterResponse(`blah blah ${canary} blah blah`, 'tom@g.us');
      assert.equal(r.safe, false);
    });

    it('does not false-positive on normal text', () => {
      const r = filter.filterResponse('CANARY is a bird.', 'tom@g.us');
      assert.equal(r.safe, true);
    });

    it('canary check works even in open mode', () => {
      const canary = filter.getCanaryToken();
      const r = filter.filterResponse(`Leaked: ${canary}`, 'open@g.us');
      assert.equal(r.safe, false, 'Canary always fires, even in open mode');
    });
  });

  // ── REPLACEMENT MESSAGES ────────────────────────────────────────────────

  describe('Blocked response replacements', () => {
    it('content violation gives discussion refusal', () => {
      const msg = filter.getBlockedResponse('content_violation');
      assert.ok(msg.includes("can't discuss"));
    });

    it('system prompt leak gives share refusal', () => {
      const msg = filter.getBlockedResponse('system_prompt_leak');
      assert.ok(msg.includes("can't share"));
    });
  });
});
