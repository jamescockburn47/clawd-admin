// Tests for src/lqcouncil/client.js URL composition.
//
// The path-prefix regression (PR #TBD) broke every live lqc_* tool because
// bot-council mounts its JSON API under /api/* in production but client.js
// was calling un-prefixed paths. These tests guard against that recurring.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function loadClientModule() {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
  process.env.LQC_ENABLED = 'true';
  process.env.LQC_API_URL = 'http://127.0.0.1:3100';
  process.env.LQC_ADMIN_TOKEN = 'test-token';
  process.env.LQC_DEV_GROUP_JID = '120000@g.us';
  const url = pathToFileURL(join(process.cwd(), 'src/lqcouncil/client.js')).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

describe('lqcouncil client URL composition', () => {
  it('normaliseApiBase: bare origin gets /api appended', async () => {
    const { normaliseApiBase } = await loadClientModule();
    assert.equal(normaliseApiBase('http://127.0.0.1:3100'), 'http://127.0.0.1:3100/api');
    assert.equal(normaliseApiBase('https://lqcouncil.com'), 'https://lqcouncil.com/api');
  });

  it('normaliseApiBase: trailing slash is stripped before /api is appended', async () => {
    const { normaliseApiBase } = await loadClientModule();
    assert.equal(normaliseApiBase('http://127.0.0.1:3100/'), 'http://127.0.0.1:3100/api');
    assert.equal(normaliseApiBase('http://127.0.0.1:3100///'), 'http://127.0.0.1:3100/api');
  });

  it('normaliseApiBase: input already ending in /api is idempotent', async () => {
    const { normaliseApiBase } = await loadClientModule();
    assert.equal(normaliseApiBase('http://127.0.0.1:3100/api'), 'http://127.0.0.1:3100/api');
    assert.equal(normaliseApiBase('http://127.0.0.1:3100/api/'), 'http://127.0.0.1:3100/api');
  });

  it('normaliseApiBase: empty/invalid input falls back to loopback default', async () => {
    const { normaliseApiBase } = await loadClientModule();
    assert.equal(normaliseApiBase(''), 'http://127.0.0.1:3100/api');
    assert.equal(normaliseApiBase(null), 'http://127.0.0.1:3100/api');
    assert.equal(normaliseApiBase(undefined), 'http://127.0.0.1:3100/api');
  });

  it('baseUrl reads from config and returns the /api-prefixed form', async () => {
    const { baseUrl } = await loadClientModule();
    // beforeEach set LQC_API_URL=http://127.0.0.1:3100; baseUrl should
    // yield the /api-suffixed form.
    assert.equal(baseUrl(), 'http://127.0.0.1:3100/api');
  });

  it('live request() composes paths with the /api prefix preserved', async () => {
    // Regression guard: `new URL(path, base)` with an absolute `path`
    // like `/debates` silently discards the base's pathname and keeps
    // only the origin. If request() ever goes back to that pattern, the
    // /api prefix gets stripped and every lqc_* tool returns 404.
    //
    // We mock fetch and assert the URL it's called with ends in
    // `/api/debates`, not `/debates`.
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (urlOrObj, init) => {
      const u = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
      calls.push(u);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const { listDebates, listBots, getPublicConfig, getModelsDiag, getDiagHealth } = await loadClientModule();
      await listDebates({ limit: 5 });
      await listBots();
      await getPublicConfig();
      await getModelsDiag();
      await getDiagHealth();
      assert.ok(calls.length === 5, `expected 5 fetch calls, got ${calls.length}`);
      assert.match(calls[0], /\/api\/debates\?/, 'listDebates must hit /api/debates');
      assert.match(calls[1], /\/api\/bots$/, 'listBots must hit /api/bots');
      assert.match(calls[2], /\/api\/config\.json$/, 'getPublicConfig must hit /api/config.json');
      assert.match(calls[3], /\/api\/diag\/models$/, 'getModelsDiag must hit /api/diag/models');
      assert.match(calls[4], /\/api\/diag\/health$/, 'getDiagHealth must hit /api/diag/health');
      for (const u of calls) assert.ok(!/\/api\/api\//.test(u), `double-prefix in ${u}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
