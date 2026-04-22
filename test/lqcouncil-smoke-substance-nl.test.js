// Tests for the three new lqcouncil tools added for natural-language
// reporting, debate substance, and full-round smoke testing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function loadHandlers() {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
  process.env.LQC_ENABLED = 'true';
  process.env.LQC_API_URL = 'http://127.0.0.1:3100';
  process.env.LQC_ADMIN_TOKEN = 'test-token';
  process.env.LQC_DEV_GROUP_JID = '120000@g.us';
  const url = pathToFileURL(join(process.cwd(), 'src/tools/lqcouncil.js')).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

function mockFetch(routeMap) {
  const calls = [];
  globalThis.fetch = async (urlOrObj, init) => {
    const u = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method, body });
    // Match by method + path OR by full URL if the test is testing an
    // external endpoint (e.g. candidate bot URL in full_smoke_test).
    const pathKey = `${method} ${new URL(u).pathname}`;
    const urlKey = `${method} ${u}`;
    const resp = routeMap[pathKey] ?? routeMap[urlKey] ?? routeMap[u] ?? { status: 500, body: { error: `no mock for ${pathKey}` } };
    const respBody = typeof resp.body === 'function' ? resp.body(body) : resp.body;
    return new Response(JSON.stringify(respBody), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

// ── lqc_debate_summary ───────────────────────────────────────────────

describe('lqc_debate_summary', () => {
  it('renders synthesis substance when debate is complete', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'GET /api/debates/abc-complete': {
        status: 200,
        body: {
          id: 'abc-complete',
          topic: 'Should AI-generated evidence be admissible?',
          status: 'complete',
          created_at: '2026-04-21T10:00:00Z',
          completed_at: '2026-04-21T10:30:00Z',
          bots: [
            { pseudonym: 'Agent A', bot_name: 'Alice', role: 'proponent' },
            { pseudonym: 'Agent B', bot_name: 'Bob', role: 'skeptic' },
          ],
          results: {
            rankings: [
              { pseudonym: 'Agent A', avg_overall: 7.2, avg_reasoning_quality: 7.5, avg_factual_grounding: 6.8, total_scores: 4 },
            ],
          },
        },
      },
      'GET /api/debates/abc-complete/synthesis': {
        status: 200,
        body: {
          synthesis: {
            topic: 'Should AI-generated evidence be admissible?',
            consensus_points: [
              { headline: 'Daubert-like scrutiny needed', point: '...', supporting_bots: ['Agent A', 'Agent B'] },
            ],
            live_disagreements: [
              {
                issue: 'Procedural safeguards',
                side_a: { headline: 'Safeguards sufficient', position: '...' },
                side_b: { headline: 'Epistemic gap fundamental', position: '...' },
              },
            ],
            minority_positions: [
              { bot: 'Agent C', headline: 'Presumptive admissibility', position: '...' },
            ],
            flagged_capitulations: [],
          },
        },
      },
    });
    try {
      const { lqcDebateSummary } = await loadHandlers();
      const out = await lqcDebateSummary({ debate_id: 'abc-complete' });
      assert.match(out, /Daubert-like scrutiny needed/);
      assert.match(out, /Safeguards sufficient/);
      assert.match(out, /Epistemic gap fundamental/);
      assert.match(out, /Agent C: Presumptive admissibility/);
      assert.match(out, /overall 7\.20/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('falls back to transcript summary when debate is in flight', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'GET /api/debates/mid-flight': {
        status: 200,
        body: {
          id: 'mid-flight',
          topic: 'Will AI replace judges?',
          status: 'round_2',
          created_at: '2026-04-21T11:00:00Z',
          completed_at: null,
          bots: [{ pseudonym: 'X', bot_name: 'x', role: 'proponent' }],
        },
      },
      'GET /api/debates/mid-flight/transcript': {
        status: 200,
        body: {
          rounds: [
            { round_number: 0, status: 'complete', responses: [{ valid: true, abstained: false }, { valid: true, abstained: false }] },
            { round_number: 1, status: 'complete', responses: [{ valid: true, abstained: false }, { valid: false, abstained: true }] },
          ],
        },
      },
    });
    try {
      const { lqcDebateSummary } = await loadHandlers();
      const out = await lqcDebateSummary({ debate_id: 'mid-flight' });
      assert.match(out, /Rounds completed.*2/);
      assert.match(out, /Round 0.*2 responded, 0 abstained/);
      assert.match(out, /Round 1.*1 responded, 1 abstained/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('rejects missing debate_id', async () => {
    const { lqcDebateSummary } = await loadHandlers();
    const out = await lqcDebateSummary({});
    assert.match(out, /debate_id is required/);
  });
});

// ── lqc_failing_bots ─────────────────────────────────────────────────

describe('lqc_failing_bots', () => {
  // /api/bots/{id}/history returns per-DEBATE aggregates. Each record has
  // rounds_total + abstained_rounds + invalid_rounds etc. Helper builds a
  // plausible list given a target fail fraction across 20 rounds total.
  const perDebateHistory = (badFraction) => {
    // 4 debates of 5 rounds each = 20 rounds total.
    const bad = Math.round(badFraction * 20);
    // Spread the bad rounds across debates roughly.
    const per = Math.floor(bad / 4);
    const leftover = bad - per * 4;
    return [
      { debate_id: 'd1', topic: 't1', status: 'complete', role: 'proponent', rounds_total: 5, abstained_rounds: per + (leftover > 0 ? 1 : 0), invalid_rounds: 0, created_at: '2026-04-21T00:00:00Z' },
      { debate_id: 'd2', topic: 't2', status: 'complete', role: 'skeptic', rounds_total: 5, abstained_rounds: per + (leftover > 1 ? 1 : 0), invalid_rounds: 0, created_at: '2026-04-21T00:00:00Z' },
      { debate_id: 'd3', topic: 't3', status: 'complete', role: 'empiricist', rounds_total: 5, abstained_rounds: per + (leftover > 2 ? 1 : 0), invalid_rounds: 0, created_at: '2026-04-21T00:00:00Z' },
      { debate_id: 'd4', topic: 't4', status: 'complete', role: 'devils_advocate', rounds_total: 5, abstained_rounds: per, invalid_rounds: 0, created_at: '2026-04-21T00:00:00Z' },
    ];
  };

  it('surfaces only bots above the abstention/invalid threshold', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'GET /api/bots': {
        status: 200,
        body: [
          { id: 'bot-healthy-0001', name: 'Healthy', status: 'active' },
          { id: 'bot-broken-0001', name: 'Broken', status: 'active', submitted_by: 'user_1' },
          { id: 'bot-inactive-0001', name: 'Inactive', status: 'inactive' },
        ],
      },
      'GET /api/bots/bot-healthy-0001/history': { status: 200, body: perDebateHistory(0.1) },   // 10% — passes
      'GET /api/bots/bot-broken-0001/history': { status: 200, body: perDebateHistory(0.75) },   // 75% — fails
      'GET /api/bots/bot-inactive-0001/history': { status: 200, body: perDebateHistory(1.0) },  // filtered out by status
    });
    try {
      const { lqcFailingBots } = await loadHandlers();
      const out = await lqcFailingBots({ threshold: 0.3 });
      assert.match(out, /Bots above/);
      assert.match(out, /Broken/);
      assert.ok(!out.includes('Healthy'), 'Healthy bot should not appear');
      assert.ok(!out.includes('Inactive'), 'Inactive bots are filtered out');
      assert.match(out, /owner: user_1/);
      // Full UUID still exposed on its own line for LLM follow-up.
      assert.match(out, /id: bot-broken-0001/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('returns all-healthy message when nothing is above threshold', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'GET /api/bots': {
        status: 200,
        body: [
          { id: 'b1', name: 'B1', status: 'active' },
          { id: 'b2', name: 'B2', status: 'active' },
        ],
      },
      'GET /api/bots/b1/history': { status: 200, body: perDebateHistory(0) },
      'GET /api/bots/b2/history': { status: 200, body: perDebateHistory(0) },
    });
    try {
      const { lqcFailingBots } = await loadHandlers();
      const out = await lqcFailingBots({});
      assert.match(out, /All 2 active bots healthy/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

// ── lqc_full_smoke_test ──────────────────────────────────────────────

describe('lqc_full_smoke_test', () => {
  it('reports PASS when all 5 rounds return valid round-specific shapes', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const round = body.round;
      const resp = { response: `stub response for round ${round}` };
      if (round >= 1) resp.confidence = 70;
      if (round === 2) resp.challenge = { claim_targeted: 'x', counter_evidence: 'y', type: 'factual' };
      if (round === 4) resp.position_change = { changed: false, from_summary: 'a', to_summary: 'b', reason: 'c' };
      return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { lqcFullSmokeTest } = await loadHandlers();
      const out = await lqcFullSmokeTest({
        endpoint_url: 'https://bot.example.com/debate',
        token: 'test-token',
        topic: 'Test topic',
      });
      assert.match(out, /Full smoke test PASS/);
      assert.match(out, /Passed 5\/5 rounds/);
      for (let r = 0; r <= 4; r++) assert.match(out, new RegExp(`Round ${r} \\[PASS\\]`));
    } finally {
      globalThis.fetch = real;
    }
  });

  it('reports PARTIAL and targeted remediation when round 2 is missing challenge', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const round = body.round;
      const resp = { response: `stub`, confidence: 70 };
      // deliberately OMIT challenge in round 2
      if (round === 4) resp.position_change = { changed: false, from_summary: 'a', to_summary: 'b', reason: 'c' };
      return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { lqcFullSmokeTest } = await loadHandlers();
      const out = await lqcFullSmokeTest({
        endpoint_url: 'https://bot.example.com/debate',
        token: 'test-token',
        topic: 'Test topic',
      });
      assert.match(out, /PARTIAL/);
      assert.match(out, /Passed 4\/5 rounds/);
      assert.match(out, /Round 2 \[FAIL\]/);
      assert.match(out, /challenge/i);
      assert.match(out, /Fix: In round 2, include/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('flags float confidence as schema_invalid_type with specific remediation', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const round = body.round;
      const resp = { response: 'stub' };
      if (round >= 1) resp.confidence = 0.7; // WRONG — should be 70
      if (round === 2) resp.challenge = { claim_targeted: 'x', counter_evidence: 'y', type: 'factual' };
      if (round === 4) resp.position_change = { changed: false, from_summary: 'a', to_summary: 'b', reason: 'c' };
      return new Response(JSON.stringify(resp), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { lqcFullSmokeTest } = await loadHandlers();
      const out = await lqcFullSmokeTest({
        endpoint_url: 'https://bot.example.com/debate',
        token: 'test-token',
        topic: 'Test topic',
      });
      // Rounds 1,2,3,4 fail; round 0 passes (no confidence needed).
      assert.match(out, /Passed 1\/5 rounds/);
      assert.match(out, /Round 0 \[PASS\]/);
      assert.match(out, /confidence must be an integer/);
      assert.match(out, /0-100 \(not 0\.7/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('reports network error with clear remediation when endpoint unreachable', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND bot.example.com'); };
    try {
      const { lqcFullSmokeTest } = await loadHandlers();
      const out = await lqcFullSmokeTest({
        endpoint_url: 'https://bot.example.com/debate',
        token: 'test-token',
        topic: 'Test topic',
      });
      assert.match(out, /Passed 0\/5 rounds/);
      for (let r = 0; r <= 4; r++) {
        assert.match(out, new RegExp(`Round ${r} \\[FAIL\\]`));
      }
      assert.match(out, /DNS, TLS, connection-refused/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('rejects missing required args without hitting the network', async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error('should not be called'); };
    try {
      const { lqcFullSmokeTest } = await loadHandlers();
      const out1 = await lqcFullSmokeTest({ endpoint_url: '', token: 't', topic: 't' });
      assert.match(out1, /endpoint_url.*required/);
      const out2 = await lqcFullSmokeTest({ endpoint_url: 'https://x', token: '', topic: 't' });
      assert.match(out2, /token.*required/);
      const out3 = await lqcFullSmokeTest({ endpoint_url: 'https://x', token: 't', topic: '' });
      assert.match(out3, /topic.*required/);
      assert.equal(called, 0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('_validateRoundResponse catches the common schema errors', async () => {
    const { _smokeInternals } = await loadHandlers();
    const { _validateRoundResponse } = _smokeInternals;

    // Round 0: response only required.
    assert.equal(_validateRoundResponse(0, { response: 'ok' }, 100).length, 0);
    assert.ok(_validateRoundResponse(0, { result: 'wrong-key' }, 100).length > 0);

    // Round 1: response + integer confidence 0-100.
    assert.equal(_validateRoundResponse(1, { response: 'ok', confidence: 50 }, 100).length, 0);
    assert.ok(_validateRoundResponse(1, { response: 'ok', confidence: 0.5 }, 100).some((e) => /integer/.test(e)));
    assert.ok(_validateRoundResponse(1, { response: 'ok', confidence: 150 }, 100).some((e) => /0-100/.test(e)));
    assert.ok(_validateRoundResponse(1, { response: 'ok' }, 100).some((e) => /confidence/.test(e)));

    // Round 2: + challenge with valid type.
    const goodR2 = { response: 'ok', confidence: 60, challenge: { claim_targeted: 'a', counter_evidence: 'b', type: 'factual' } };
    assert.equal(_validateRoundResponse(2, goodR2, 100).length, 0);
    assert.ok(_validateRoundResponse(2, { response: 'ok', confidence: 60 }, 100).some((e) => /challenge.*missing/));
    const badR2 = { response: 'ok', confidence: 60, challenge: { claim_targeted: 'a', counter_evidence: 'b', type: 'emotional' } };
    assert.ok(_validateRoundResponse(2, badR2, 100).some((e) => /factual\|logical\|premise/));

    // Round 4: + position_change.
    const goodR4 = { response: 'ok', confidence: 60, position_change: { changed: false, from_summary: 'a', to_summary: 'b', reason: 'c' } };
    assert.equal(_validateRoundResponse(4, goodR4, 100).length, 0);
    assert.ok(_validateRoundResponse(4, { response: 'ok', confidence: 60 }, 100).some((e) => /position_change.*missing/));
  });
});
