import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

async function loadProgress(lqcMock) {
  return esmock('../src/lqcouncil/debate-progress.js', {
    '../src/lqcouncil/client.js': lqcMock,
  });
}

describe('lastCompletedRound', () => {
  it('maps status strings to the correct last-completed round index', async () => {
    const { lastCompletedRound } = await loadProgress({});
    assert.equal(lastCompletedRound('created'), null);
    assert.equal(lastCompletedRound('round_0'), null);
    assert.equal(lastCompletedRound('round_1'), 0);
    assert.equal(lastCompletedRound('round_2'), 1);
    assert.equal(lastCompletedRound('round_4'), 3);
    assert.equal(lastCompletedRound('analysing'), 4);
    assert.equal(lastCompletedRound('synthesising'), 4);
    assert.equal(lastCompletedRound('complete'), 4);
    assert.equal(lastCompletedRound('failed'), null);
    assert.equal(lastCompletedRound('cancelled'), null);
    assert.equal(lastCompletedRound(undefined), null);
  });
});

describe('buildRoundSummary', () => {
  let lqcMock;

  beforeEach(() => {
    lqcMock = {
      getDebate: async () => ({
        id: 'd1',
        topic: 'Should AI cert?',
        bots: [
          { pseudonym: 'Agent A', bot_name: 'Clint', role: 'proponent' },
          { pseudonym: 'Agent B', bot_name: 'Alice', role: 'skeptic' },
        ],
      }),
      getTranscript: async () => ({
        rounds: [
          { round_number: 0, responses: [] },
          {
            round_number: 1,
            responses: [
              { pseudonym: 'Agent A', confidence: 72, valid: true, abstained: false, response: 'Certificates raise verification cost. Orgs will require them.' },
              { pseudonym: 'Agent B', confidence: 55, valid: true, abstained: false, response: 'The proposal ignores cost asymmetries for small labs.' },
            ],
          },
        ],
      }),
    };
  });

  it('formats a round summary with bot names, confidence and first-sentence snippets', async () => {
    const { buildRoundSummary } = await loadProgress(lqcMock);
    const out = await buildRoundSummary('d1', 1);
    assert.ok(out.includes('Round 1 complete'));
    assert.ok(out.includes('Should AI cert?'));
    assert.ok(out.includes('*Clint* [conf 72]'));
    assert.ok(out.includes('*Alice* [conf 55]'));
    assert.ok(out.includes('Certificates raise verification cost.'));
    assert.ok(!out.includes('Orgs will require them.'), 'only the first sentence should appear');
  });

  it('marks abstained responses', async () => {
    lqcMock.getTranscript = async () => ({
      rounds: [{ round_number: 1, responses: [{ pseudonym: 'Agent A', valid: false, abstained: true, response: '' }] }],
    });
    const { buildRoundSummary } = await loadProgress(lqcMock);
    const out = await buildRoundSummary('d1', 1);
    assert.ok(out.includes('_[abstained]_'));
  });

  it('returns null when round not in transcript', async () => {
    const { buildRoundSummary } = await loadProgress(lqcMock);
    const out = await buildRoundSummary('d1', 99);
    assert.equal(out, null);
  });

  it('returns null on fetch failure', async () => {
    const failing = { getDebate: async () => { throw new Error('503'); }, getTranscript: async () => ({}) };
    const { buildRoundSummary } = await loadProgress(failing);
    const out = await buildRoundSummary('d1', 1);
    assert.equal(out, null);
  });
});

describe('buildFinalCommentary', () => {
  const detailFn = async () => ({ id: 'd1', topic: 'AI certs', bots: [] });
  const synth = {
    consensus_points: [
      { point: 'Verification has real cost' },
      { point: 'Labs would game disclosure' },
    ],
    live_disagreements: [{ point: 'Whether certs should be mandatory' }],
    minority_positions: [{ point: 'Self-certification is sufficient' }],
    flagged_capitulations: [{ point: 'Agent C dropped position in round 2' }],
    meta_observations: 'Debate converged on procedural agreement; substantive disagreement remains.',
  };

  it('renders all synthesis sections with truncation', async () => {
    const { buildFinalCommentary } = await loadProgress({
      getDebate: detailFn,
      getSynthesis: async () => ({ synthesis: synth }),
    });
    const out = await buildFinalCommentary('d1');
    assert.ok(out.includes('Debate complete'));
    assert.ok(out.includes('*Consensus:*'));
    assert.ok(out.includes('Verification has real cost'));
    assert.ok(out.includes('*Live disagreements:*'));
    assert.ok(out.includes('Whether certs should be mandatory'));
    assert.ok(out.includes('*Minority positions:*'));
    assert.ok(out.includes('*Capitulations flagged:*'));
    assert.ok(out.includes('*Meta:*'));
    assert.ok(out.includes('procedural agreement'));
  });

  it('handles raw synthesis (no wrapper object)', async () => {
    const { buildFinalCommentary } = await loadProgress({
      getDebate: detailFn,
      getSynthesis: async () => synth,
    });
    const out = await buildFinalCommentary('d1');
    assert.ok(out.includes('Verification has real cost'));
  });

  it('returns null on fetch failure', async () => {
    const { buildFinalCommentary } = await loadProgress({
      getDebate: async () => { throw new Error('504'); },
      getSynthesis: async () => ({}),
    });
    const out = await buildFinalCommentary('d1');
    assert.equal(out, null);
  });
});

describe('buildDebateMemoryText', () => {
  it('includes topic, participants, every round response, and synthesis', async () => {
    const { buildDebateMemoryText } = await loadProgress({
      getDebate: async () => ({
        id: 'd1',
        topic: 'AI certs',
        status: 'complete',
        created_at: '2026-04-19T10:00:00Z',
        completed_at: '2026-04-19T10:20:00Z',
        bots: [
          { pseudonym: 'Agent A', bot_name: 'Clint', role: 'proponent' },
          { pseudonym: 'Agent B', bot_name: 'Alice', role: 'skeptic' },
        ],
      }),
      getTranscript: async () => ({
        rounds: [
          {
            round_number: 0,
            responses: [
              { pseudonym: 'Agent A', confidence: 70, valid: true, response: 'Clint initial position text.' },
              { pseudonym: 'Agent B', confidence: 60, valid: true, response: 'Alice initial position text.' },
            ],
          },
          {
            round_number: 2,
            responses: [
              { pseudonym: 'Agent A', confidence: 75, valid: true, response: 'Clint challenge rebuttal.',
                challenge: { type: 'logical', claim_targeted: 'Alice main claim', counter_evidence: 'counter-evidence X' } },
            ],
          },
        ],
      }),
      getSynthesis: async () => ({
        synthesis: {
          consensus_points: [{ point: 'Verification cost is real', evidence: 'Clint R0' }],
          meta_observations: 'Strong disagreement overall.',
        },
      }),
    });
    const text = await buildDebateMemoryText('d1');
    assert.ok(text);
    assert.ok(text.includes('LQ Council debate d1'));
    assert.ok(text.includes('Topic: AI certs'));
    assert.ok(text.includes('Clint (Agent A, role: proponent)'));
    assert.ok(text.includes('Alice (Agent B, role: skeptic)'));
    assert.ok(text.includes('### Round 0'));
    assert.ok(text.includes('### Round 2'));
    assert.ok(text.includes('Clint initial position text.'));
    assert.ok(text.includes('Alice initial position text.'));
    assert.ok(text.includes('challenge: type=logical'));
    assert.ok(text.includes('### Synthesis'));
    assert.ok(text.includes('Verification cost is real'));
    assert.ok(text.includes('Strong disagreement overall.'));
  });

  it('returns null when transcript fetch fails', async () => {
    const { buildDebateMemoryText } = await loadProgress({
      getDebate: async () => ({ bots: [] }),
      getTranscript: async () => { throw new Error('503'); },
      getSynthesis: async () => ({}),
    });
    const out = await buildDebateMemoryText('d1');
    assert.equal(out, null);
  });

  it('tolerates missing synthesis (failed debate with transcript only)', async () => {
    const { buildDebateMemoryText } = await loadProgress({
      getDebate: async () => ({ id: 'd1', topic: 'T', bots: [] }),
      getTranscript: async () => ({ rounds: [{ round_number: 0, responses: [] }] }),
      getSynthesis: async () => { throw new Error('no synthesis for failed debate'); },
    });
    const text = await buildDebateMemoryText('d1');
    assert.ok(text);
    assert.ok(text.includes('Topic: T'));
    assert.ok(!text.includes('### Synthesis'), 'synthesis section should be omitted when missing');
  });
});
