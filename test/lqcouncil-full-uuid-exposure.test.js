// Regression guard: list-shaped lqc_* tools must expose the FULL UUID
// of each entry, not just the 8-char display prefix. The LLM reading
// the tool result needs the full id to pass into follow-up tool calls
// (lqc_debate_summary, lqc_bot_diagnose, etc.). Historically lqc_list_*
// only emitted the prefix, which caused the backend to 404 on follow-ups.

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

function mockFetch(map) {
  globalThis.fetch = async (urlOrObj) => {
    const u = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
    const pathKey = new URL(u).pathname + (new URL(u).search ? '' : ''); // ignore query
    const base = pathKey.split('?')[0];
    const resp = map[base] ?? { status: 500, body: { error: 'no mock' } };
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const FULL_ID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

describe('list tools expose full UUIDs for LLM follow-up', () => {
  it('lqcListDebates includes the full UUID on every line', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/debates': {
        status: 200,
        body: [
          { id: 'e1f370d9-aaaa-bbbb-cccc-111111111111', topic: 'T1', status: 'complete', created_at: '2026-04-21T10:00:00Z', completed_at: '2026-04-21T10:30:00Z', bots: [{ pseudonym: 'A' }, { pseudonym: 'B' }] },
          { id: 'c6be81a6-dddd-eeee-ffff-222222222222', topic: 'T2', status: 'round_1', created_at: '2026-04-21T11:00:00Z', completed_at: null, bots: [] },
        ],
      },
    });
    try {
      const { lqcListDebates } = await loadHandlers();
      const out = await lqcListDebates({ limit: 10 });
      assert.match(out, /e1f370d9-aaaa-bbbb-cccc-111111111111/, 'full UUID of debate 1 must appear');
      assert.match(out, /c6be81a6-dddd-eeee-ffff-222222222222/, 'full UUID of debate 2 must appear');
      // Also assert both appear under an "id:" tag so the LLM recognises them.
      assert.match(out, /id: e1f370d9-aaaa-bbbb-cccc-111111111111/);
      assert.match(out, /id: c6be81a6-dddd-eeee-ffff-222222222222/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('lqcListBots includes the full UUID on every line', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/bots': {
        status: 200,
        body: [
          { id: 'de1c7eae-b477-4373-ac97-72b0b80765e1', name: 'Akechi', status: 'active', endpoint_url: 'https://x.example/debate' },
          { id: 'ef1d4843-a207-4752-a96b-df3b4241540d', name: 'Alice', status: 'active', endpoint_url: 'https://y.example/debate', submitted_by: 'user_abc' },
        ],
      },
    });
    try {
      const { lqcListBots } = await loadHandlers();
      const out = await lqcListBots({});
      assert.match(out, /id: de1c7eae-b477-4373-ac97-72b0b80765e1/);
      assert.match(out, /id: ef1d4843-a207-4752-a96b-df3b4241540d/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('lqcStatus recent-debates lines include the full UUID', async () => {
    const real = globalThis.fetch;
    mockFetch({
      '/api/diag/health': { status: 200, body: { status: 'ok' } },
      '/api/config.json': { status: 200, body: { release: 'abc123', sentry_environment: 'prod' } },
      '/api/diag/models': { status: 200, body: { analysis_model: 'MiniMax-M2.7', analysis_base_url: 'https://api.minimax.io' } },
      '/api/debates': {
        status: 200,
        body: [
          { id: 'e1f370d9-aaaa-bbbb-cccc-111111111111', topic: 'Child of God', status: 'complete', created_at: '2026-04-21', completed_at: '2026-04-21', bots: [] },
        ],
      },
    });
    try {
      const { lqcStatus } = await loadHandlers();
      const out = await lqcStatus();
      assert.match(out, /id: e1f370d9-aaaa-bbbb-cccc-111111111111/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('lqcFailingBots emits full UUIDs for LLM follow-up', async () => {
    const real = globalThis.fetch;
    // Per-debate aggregates; 20/20 rounds abstained across 4 debates.
    const history = [
      { debate_id: 'd1', topic: 't', status: 'complete', role: 'proponent',       rounds_total: 5, abstained_rounds: 5, invalid_rounds: 0, created_at: '2026-04-21' },
      { debate_id: 'd2', topic: 't', status: 'complete', role: 'skeptic',         rounds_total: 5, abstained_rounds: 5, invalid_rounds: 0, created_at: '2026-04-21' },
      { debate_id: 'd3', topic: 't', status: 'complete', role: 'empiricist',      rounds_total: 5, abstained_rounds: 5, invalid_rounds: 0, created_at: '2026-04-21' },
      { debate_id: 'd4', topic: 't', status: 'complete', role: 'devils_advocate', rounds_total: 5, abstained_rounds: 5, invalid_rounds: 0, created_at: '2026-04-21' },
    ];
    mockFetch({
      '/api/bots': { status: 200, body: [{ id: 'de1c7eae-b477-4373-ac97-72b0b80765e1', name: 'Akechi', status: 'active', submitted_by: 'user_x' }] },
      '/api/bots/de1c7eae-b477-4373-ac97-72b0b80765e1/history': { status: 200, body: history },
    });
    try {
      const { lqcFailingBots } = await loadHandlers();
      const out = await lqcFailingBots({});
      assert.match(out, /de1c7eae-b477-4373-ac97-72b0b80765e1/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
