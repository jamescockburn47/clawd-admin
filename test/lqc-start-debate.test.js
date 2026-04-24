import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// Mirrors the DEFAULT_DEBATE_BOT_NAMES roster in src/tools/lqcouncil.js.
// An "off-roster" active bot (Xeno) is present to verify it is NOT
// auto-picked; an inactive "Clint-B" is present to verify status is
// still honoured for bots whose names match the default roster.
const ACTIVE_BOTS = [
  { id: 'bot-clint', name: 'Clint', status: 'active' },
  { id: 'bot-alice', name: 'Alice', status: 'active' },
  { id: 'bot-oscar', name: 'Oscar', status: 'active' },
  { id: 'bot-lqclaw', name: 'Jamie-LQClaw', status: 'active' },
  { id: 'bot-xeno', name: 'Xeno', status: 'active' },
  { id: 'bot-clint-b', name: 'Clint-B', status: 'inactive' },
];

async function loadTools({ lqcMock, clearPending = true } = {}) {
  const mod = await esmock('../src/tools/lqcouncil.js', {
    '../src/lqcouncil/client.js': lqcMock,
  });
  if (clearPending) {
    const pending = await esmock('../src/lqcouncil/pending-debates.js', {});
    pending.clearAllProposals();
  }
  return mod;
}

describe('lqc_start_debate proposal flow', () => {
  let lqcMock;

  beforeEach(() => {
    lqcMock = {
      listBots: async () => ACTIVE_BOTS,
      createDebate: async ({ topic, bot_ids }) => ({ id: `deb-${topic.slice(0, 4)}`, topic, bot_ids }),
    };
  });

  it('auto-picks the default roster, not just any active bot', async () => {
    const tools = await loadTools({ lqcMock });
    const out = await tools.lqcStartDebate({ topic: 'Should AI replace lawyers?' });
    assert.ok(out.includes('Bots (4):'), `expected 4 default-roster bots, got: ${out}`);
    assert.ok(out.includes('Jamie-LQClaw, Alice, Oscar, Clint'), `roster order should match DEFAULT_DEBATE_BOT_NAMES: ${out}`);
    assert.ok(!out.includes('Xeno'), 'off-roster active bots must NOT be auto-picked');
    assert.ok(!out.includes('Clint-B'), 'inactive bots must not appear');
    assert.ok(out.includes('Should AI replace lawyers?'));
    assert.ok(/lqc_confirm_debate [a-f0-9]{8}/.test(out), 'must include confirm_id');
  });

  it('refuses to run if a default-roster bot is missing or inactive', async () => {
    const incompleteLqc = {
      listBots: async () => [
        { id: 'bot-clint', name: 'Clint', status: 'active' },
        { id: 'bot-alice', name: 'Alice', status: 'active' },
        { id: 'bot-oscar', name: 'Oscar', status: 'inactive' }, // demoted
        // Jamie-LQClaw missing entirely
      ],
      createDebate: async () => ({ id: 'x' }),
    };
    const tools = await loadTools({ lqcMock: incompleteLqc });
    const out = await tools.lqcStartDebate({ topic: 'T' });
    assert.ok(out.includes('Default roster incomplete'));
    assert.ok(out.includes('Oscar'));
    assert.ok(out.includes('Jamie-LQClaw'));
  });

  it('rejects missing or blank topic', async () => {
    const tools = await loadTools({ lqcMock });
    const blank = await tools.lqcStartDebate({ topic: '   ' });
    assert.ok(blank.includes('topic is required'));
    const missing = await tools.lqcStartDebate({});
    assert.ok(missing.includes('topic is required'));
  });

  it('rejects topic exceeding 300 chars', async () => {
    const tools = await loadTools({ lqcMock });
    const out = await tools.lqcStartDebate({ topic: 'a'.repeat(301) });
    assert.ok(out.includes('Topic too long'));
    assert.ok(out.includes('301'));
  });

  it('uses explicit bot_ids when provided, rejects unknown ones', async () => {
    const tools = await loadTools({ lqcMock });
    const ok = await tools.lqcStartDebate({ topic: 'T', bot_ids: ['bot-clint', 'bot-alice'] });
    assert.ok(ok.includes('Bots (2):'));
    assert.ok(ok.includes('Clint, Alice'));

    const bad = await tools.lqcStartDebate({ topic: 'T', bot_ids: ['bot-does-not-exist'] });
    assert.ok(bad.includes('Unknown bot id'));
  });

  it('refuses when an explicit bot_ids list has fewer than 2 bots', async () => {
    const tools = await loadTools({ lqcMock });
    const out = await tools.lqcStartDebate({ topic: 'T', bot_ids: ['bot-clint'] });
    assert.ok(out.includes('at least 2 active bots'), `unexpected: ${out}`);
  });

  it('surfaces listBots failure cleanly', async () => {
    const failingLqc = {
      listBots: async () => { throw new Error('upstream 503'); },
      createDebate: async () => ({}),
    };
    const tools = await loadTools({ lqcMock: failingLqc });
    const out = await tools.lqcStartDebate({ topic: 'T' });
    assert.ok(out.startsWith('Could not fetch bot roster'));
    assert.ok(out.includes('upstream 503'));
  });
});

describe('lqc_confirm_debate firing and replay protection', () => {
  let lqcMock;
  let createDebateCalls;

  beforeEach(() => {
    createDebateCalls = [];
    lqcMock = {
      listBots: async () => ACTIVE_BOTS,
      createDebate: async (args) => {
        createDebateCalls.push(args);
        return { id: `deb-${args.topic.slice(0, 6)}`, topic: args.topic };
      },
    };
  });

  it('confirms a valid pending proposal and calls POST /debates', async () => {
    const tools = await loadTools({ lqcMock });
    const proposal = await tools.lqcStartDebate({ topic: 'Remote work' });
    const confirmId = proposal.match(/lqc_confirm_debate ([a-f0-9]{8})/)[1];

    const result = await tools.lqcConfirmDebate({ confirm_id: confirmId });
    assert.equal(createDebateCalls.length, 1);
    assert.equal(createDebateCalls[0].topic, 'Remote work');
    assert.equal(createDebateCalls[0].bot_ids.length, 4);
    assert.ok(result.includes('Debate started'));
    assert.ok(result.includes('deb-Remote'));
  });

  it('refuses replay of a consumed confirm_id', async () => {
    const tools = await loadTools({ lqcMock });
    const proposal = await tools.lqcStartDebate({ topic: 'Remote work' });
    const confirmId = proposal.match(/lqc_confirm_debate ([a-f0-9]{8})/)[1];

    await tools.lqcConfirmDebate({ confirm_id: confirmId });
    const second = await tools.lqcConfirmDebate({ confirm_id: confirmId });

    assert.equal(createDebateCalls.length, 1, 'must not fire a second debate');
    assert.ok(second.includes('No pending debate'));
  });

  it('refuses unknown confirm_id', async () => {
    const tools = await loadTools({ lqcMock });
    const out = await tools.lqcConfirmDebate({ confirm_id: 'deadbeef' });
    assert.ok(out.includes('No pending debate'));
    assert.equal(createDebateCalls.length, 0);
  });

  it('refuses blank confirm_id', async () => {
    const tools = await loadTools({ lqcMock });
    const out = await tools.lqcConfirmDebate({});
    assert.ok(out.includes('confirm_id is required'));
    assert.equal(createDebateCalls.length, 0);
  });

  it('surfaces createDebate failure without consuming proposal poorly', async () => {
    const failingLqc = {
      listBots: async () => ACTIVE_BOTS,
      createDebate: async () => { throw new Error('HTTP 503'); },
    };
    const tools = await loadTools({ lqcMock: failingLqc });
    const proposal = await tools.lqcStartDebate({ topic: 'T' });
    const confirmId = proposal.match(/lqc_confirm_debate ([a-f0-9]{8})/)[1];
    const result = await tools.lqcConfirmDebate({ confirm_id: confirmId });
    assert.ok(result.startsWith('Failed to start debate'));
    assert.ok(result.includes('HTTP 503'));
  });
});
