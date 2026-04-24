// Regression guard for the /api/bots/{id}/history per-debate shape and
// the /api/bots/schema deprecated-wrapper shape.
//
// Previous bug: lqc_failing_bots / lqc_bot_diagnose / failure-nudge all
// filtered history with `.filter(r => r.abstained || !r.valid)`, but
// /api/bots/{id}/history returns per-DEBATE aggregates with fields
// {rounds_total, abstained_rounds, invalid_rounds, ...} — not per-round
// with {abstained, valid}. Every record matched → 100% false-positive
// failure rate. Same issue for the schema formatter which read
// schema.dialect / schema.version that don't exist.

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
  globalThis.fetch = async (urlOrObj) => {
    const u = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
    const pathKey = new URL(u).pathname;
    const resp = routeMap[pathKey] ?? { status: 500, body: { error: `no mock for ${pathKey}` } };
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('lqc_bot_diagnose — per-debate history aggregation', () => {
  it('aggregates rounds across debates and reports the correct rate', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/bots/bot-xyz/history': {
        status: 200,
        body: [
          { debate_id: 'd1', topic: 'Topic 1', status: 'complete', role: 'proponent', rounds_total: 5, abstained_rounds: 0, invalid_rounds: 0, created_at: '2026-04-21' },
          { debate_id: 'd2', topic: 'Topic 2', status: 'complete', role: 'skeptic',   rounds_total: 5, abstained_rounds: 3, invalid_rounds: 1, created_at: '2026-04-20' },
          { debate_id: 'd3', topic: 'Topic 3', status: 'round_2',  role: 'empiricist', rounds_total: 2, abstained_rounds: 1, invalid_rounds: 0, created_at: '2026-04-19' },
        ],
      },
    });
    try {
      const { lqcBotDiagnose } = await loadHandlers();
      const out = await lqcBotDiagnose({ bot_id: 'bot-xyz' });
      // 12 rounds total, 5 bad → 41.67% ≈ 42%
      assert.match(out, /rounds: 12/);
      assert.match(out, /abstained: 4/);
      assert.match(out, /invalid: 1/);
      assert.match(out, /42%|41%/); // accept either rounding
      // Status breakdown surfaces actual debate states
      assert.match(out, /complete×2/);
      assert.match(out, /round_2×1/);
      // Worst-debates list shows bad debates with full IDs for follow-up
      assert.match(out, /Topic 2/);
      assert.match(out, /id: d2/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('reports healthy when no abstentions or invalids across debates', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/bots/healthy-bot/history': {
        status: 200,
        body: [
          { debate_id: 'd1', topic: 'T', status: 'complete', role: 'proponent', rounds_total: 5, abstained_rounds: 0, invalid_rounds: 0, created_at: '2026-04-21' },
          { debate_id: 'd2', topic: 'T2', status: 'complete', role: 'skeptic',  rounds_total: 5, abstained_rounds: 0, invalid_rounds: 0, created_at: '2026-04-20' },
        ],
      },
    });
    try {
      const { lqcBotDiagnose } = await loadHandlers();
      const out = await lqcBotDiagnose({ bot_id: 'healthy-bot' });
      assert.match(out, /Bot is healthy/);
      assert.match(out, /rounds: 10/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('handles empty history with a clear message', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/bots/new-bot/history': { status: 200, body: [] },
    });
    try {
      const { lqcBotDiagnose } = await loadHandlers();
      const out = await lqcBotDiagnose({ bot_id: 'new-bot' });
      assert.match(out, /No debate history/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('lqc_bot_schema — deprecated-wrapper shape', () => {
  it('surfaces the deprecation notice and still renders request/response', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/bots/schema': {
        status: 200,
        body: {
          deprecated: true,
          replacement: 'See /bots/guide and /bots/{id}/test for validation flow',
          request: {
            type: 'object',
            required: ['session_id', 'round', 'role', 'context', 'prompt'],
            properties: {
              session_id: { type: 'string' },
              round: { type: 'integer', minimum: 0 },
              role: { type: 'string' },
              context: { type: 'array' },
              prompt: { type: 'string' },
            },
          },
          response: {
            type: 'object',
            required: ['response'],
            properties: {
              response: { type: 'string' },
              confidence: { type: 'integer' },
              challenge: { type: 'object' },
              position_change: { type: 'object' },
            },
          },
        },
      },
    });
    try {
      const { lqcBotSchema } = await loadHandlers();
      const out = await lqcBotSchema();
      assert.match(out, /Bot wire schema/);
      assert.match(out, /deprecated/);
      assert.match(out, /Replacement: See \/bots\/guide/);
      assert.match(out, /DebateRoundRequest/);
      assert.match(out, /session_id \(string, required\)/);
      assert.match(out, /DebateRoundResponse/);
      assert.match(out, /response \(string, required\)/);
      // Must NOT contain the string "undefined" — previous bug read
      // non-existent dialect/version.
      assert.ok(!out.includes('undefined'), `expected no "undefined" in output, got: ${out}`);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('renders without a deprecation notice when the endpoint is not flagged', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/bots/schema': {
        status: 200,
        body: {
          request: { type: 'object', properties: { session_id: { type: 'string' } }, required: [] },
          response: { type: 'object', properties: { response: { type: 'string' } }, required: ['response'] },
        },
      },
    });
    try {
      const { lqcBotSchema } = await loadHandlers();
      const out = await lqcBotSchema();
      assert.ok(!out.toLowerCase().includes('deprecated'));
      assert.match(out, /DebateRoundRequest/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
