// Tests for Phase D Clint tools: lqc_live_llm, lqc_archive_debate,
// lqc_delete_debate. Covers client URL shape (PATCH /archive, DELETE),
// the archive/unarchive verb flip, and the two-step delete confirm flow
// (stage → confirm, with TTL pruning so a stale stage can't replay).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function loadClient() {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
  process.env.LQC_ENABLED = 'true';
  process.env.LQC_API_URL = 'http://127.0.0.1:3100';
  process.env.LQC_ADMIN_TOKEN = 'test-token';
  process.env.LQC_DEV_GROUP_JID = '120000@g.us';
  const url = pathToFileURL(join(process.cwd(), 'src/lqcouncil/client.js')).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

async function loadHandlers() {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
  process.env.LQC_ENABLED = 'true';
  process.env.LQC_API_URL = 'http://127.0.0.1:3100';
  process.env.LQC_ADMIN_TOKEN = 'test-token';
  process.env.LQC_DEV_GROUP_JID = '120000@g.us';
  const url = pathToFileURL(join(process.cwd(), 'src/tools/lqcouncil.js')).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

function mockFetch(respMap) {
  const calls = [];
  globalThis.fetch = async (urlOrObj, init) => {
    const u = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, method, body });
    const key = `${method} ${new URL(u).pathname}`;
    const resp = respMap[key] ?? { status: 500, body: { error: `no mock for ${key}` } };
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

describe('client: Phase D methods', () => {
  beforeEach(() => {
    delete globalThis._realFetch;
  });

  it('archiveDebate PATCHes /api/debates/{id}/archive with {archived}', async () => {
    const real = globalThis.fetch;
    const calls = mockFetch({
      'PATCH /api/debates/abc-123/archive': { status: 200, body: { archived_at: '2026-04-21T20:00:00Z' } },
    });
    try {
      const { archiveDebate } = await loadClient();
      const out = await archiveDebate('abc-123', true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'PATCH');
      assert.match(calls[0].url, /\/api\/debates\/abc-123\/archive$/);
      assert.deepEqual(calls[0].body, { archived: true });
      assert.equal(out.archived_at, '2026-04-21T20:00:00Z');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('deleteDebate DELETEs /api/debates/{id}', async () => {
    const real = globalThis.fetch;
    const calls = mockFetch({
      'DELETE /api/debates/abc-123': { status: 200, body: {} },
    });
    try {
      const { deleteDebate } = await loadClient();
      await deleteDebate('abc-123');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'DELETE');
      assert.match(calls[0].url, /\/api\/debates\/abc-123$/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('handler: lqcArchiveDebate', () => {
  it('reports "archived" when archived=true (default)', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'PATCH /api/debates/abc123def456/archive': { status: 200, body: { archived_at: '2026-04-21T20:00:00Z' } },
    });
    try {
      const { lqcArchiveDebate } = await loadHandlers();
      const out = await lqcArchiveDebate({ debate_id: 'abc123def456' });
      assert.match(out, /archived/);
      assert.match(out, /abc123de/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('reports "unarchived" when archived=false', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'PATCH /api/debates/abc123def456/archive': { status: 200, body: { archived_at: null } },
    });
    try {
      const { lqcArchiveDebate } = await loadHandlers();
      const out = await lqcArchiveDebate({ debate_id: 'abc123def456', archived: false });
      assert.match(out, /unarchived/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('rejects missing debate_id without touching the network', async () => {
    const real = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; throw new Error('should not be called'); };
    try {
      const { lqcArchiveDebate } = await loadHandlers();
      const out = await lqcArchiveDebate({});
      assert.match(out, /debate_id is required/);
      assert.equal(called, 0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('handler: lqcDeleteDebate two-step confirm', () => {
  it('first call stages and returns a confirmation prompt; does NOT hit DELETE', async () => {
    const real = globalThis.fetch;
    const calls = mockFetch({
      'GET /api/debates/del-test-123': {
        status: 200,
        body: { id: 'del-test-123', topic: 'test topic', status: 'complete', bots: [{}, {}] },
      },
    });
    try {
      const { lqcDeleteDebate, _resetPendingDeletesForTests } = await loadHandlers();
      _resetPendingDeletesForTests();
      const out = await lqcDeleteDebate({ debate_id: 'del-test-123' });
      assert.match(out, /About to DELETE/);
      assert.match(out, /test topic/);
      assert.match(out, /confirm: true/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'GET'); // preview fetch only, no DELETE
    } finally {
      globalThis.fetch = real;
    }
  });

  it('second call with confirm fires the DELETE', async () => {
    const real = globalThis.fetch;
    const calls = mockFetch({
      'GET /api/debates/del-test-456': {
        status: 200,
        body: { id: 'del-test-456', topic: 't', status: 'complete', bots: [] },
      },
      'DELETE /api/debates/del-test-456': { status: 200, body: {} },
    });
    try {
      const { lqcDeleteDebate, _resetPendingDeletesForTests } = await loadHandlers();
      _resetPendingDeletesForTests();
      await lqcDeleteDebate({ debate_id: 'del-test-456' });
      const out2 = await lqcDeleteDebate({ debate_id: 'del-test-456', confirm: true });
      assert.match(out2, /deleted/);
      const deleteCall = calls.find((c) => c.method === 'DELETE');
      assert.ok(deleteCall, 'DELETE must have been called on confirm');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('confirm without a prior stage is rejected', async () => {
    const real = globalThis.fetch;
    let deleteCalls = 0;
    globalThis.fetch = async (url, init) => {
      if ((init?.method || 'GET') === 'DELETE') deleteCalls++;
      return new Response('{}', { status: 200 });
    };
    try {
      const { lqcDeleteDebate, _resetPendingDeletesForTests } = await loadHandlers();
      _resetPendingDeletesForTests();
      const out = await lqcDeleteDebate({ debate_id: 'unstaged-id', confirm: true });
      assert.match(out, /No staged delete/);
      assert.equal(deleteCalls, 0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('handler: lqcLiveLlm', () => {
  it('reports MiniMax when routing points at api.minimax.io', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'GET /api/diag/models': {
        status: 200,
        body: {
          analysis_base_url: 'https://api.minimax.io',
          analysis_model: 'MiniMax-M2.7',
          final_synthesis_base_url: 'https://api.minimax.io',
          final_synthesis_model: 'MiniMax-M2.7',
          analysis_request_timeout_secs: 120,
          final_synthesis_request_timeout_secs: 900,
          analysis_max_concurrency: 2,
          final_synthesis_warmup_enabled: false,
        },
      },
    });
    try {
      const { lqcLiveLlm } = await loadHandlers();
      const out = await lqcLiveLlm();
      assert.match(out, /MiniMax-M2.7/);
      assert.match(out, /api\.minimax\.io/);
      assert.match(out, /Live on MiniMax/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('reports local llama-server when routing points at loopback', async () => {
    const real = globalThis.fetch;
    mockFetch({
      'GET /api/diag/models': {
        status: 200,
        body: {
          analysis_base_url: 'http://127.0.0.1:8086',
          analysis_model: 'gemma-4-31B-it-Q4_K_M.gguf',
          final_synthesis_base_url: 'http://127.0.0.1:8086',
          final_synthesis_model: 'gemma-4-31B-it-Q4_K_M.gguf',
        },
      },
    });
    try {
      const { lqcLiveLlm } = await loadHandlers();
      const out = await lqcLiveLlm();
      assert.match(out, /gemma-4-31B/);
      assert.match(out, /Live on local llama-server/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
