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
});
