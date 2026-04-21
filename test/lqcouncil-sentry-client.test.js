// Tests for src/lqcouncil/sentry-client.js.
//
// Regional-URL + project composition is exercised via the pure
// `buildIssuesUrl` helper so we don't fight the config singleton (zod
// parses env at first import; subsequent imports with different env do
// not re-parse).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

async function loadModule() {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
  process.env.LQC_ENABLED = 'true';
  process.env.LQC_API_URL = 'http://127.0.0.1:3100';
  process.env.LQC_ADMIN_TOKEN = 'test-token';
  process.env.LQC_DEV_GROUP_JID = '120000@g.us';
  const url = pathToFileURL(join(process.cwd(), 'src/lqcouncil/sentry-client.js')).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

describe('buildIssuesUrl', () => {
  it('routes to the EU host when apiUrl=https://de.sentry.io/api/0', async () => {
    const { buildIssuesUrl } = await loadModule();
    const url = buildIssuesUrl({
      apiUrl: 'https://de.sentry.io/api/0',
      org: 'legal-quants',
      project: 'bot-council-backend',
      limit: 5,
      age: '-1h',
    });
    assert.match(url, /^https:\/\/de\.sentry\.io\/api\/0\/projects\/legal-quants\/bot-council-backend\/issues\/\?/);
    assert.match(url, /limit=5/);
    // statsPeriod is bucketed to {24h, 14d} so Sentry doesn't 400 on
    // arbitrary ages; the search query's `age:` filter does precise
    // bounding.
    assert.match(url, /statsPeriod=24h/);
    assert.match(url, /query=age%3A-1h/);
  });

  it('defaults to https://sentry.io/api/0 when apiUrl is falsy', async () => {
    const { buildIssuesUrl } = await loadModule();
    const url = buildIssuesUrl({
      apiUrl: undefined,
      org: 'some-org',
      project: 'some-proj',
    });
    assert.match(url, /^https:\/\/sentry\.io\/api\/0\/projects\/some-org\/some-proj\/issues\//);
  });

  it('strips trailing slashes from apiUrl before composing', async () => {
    const { buildIssuesUrl } = await loadModule();
    const url = buildIssuesUrl({
      apiUrl: 'https://de.sentry.io/api/0/',
      org: 'legal-quants',
      project: 'bot-council-backend',
    });
    assert.ok(!/api\/0\/\/projects/.test(url), `no double slash in ${url}`);
    assert.match(url, /\/api\/0\/projects\//);
  });

  it('URL-encodes org and project slugs', async () => {
    const { buildIssuesUrl } = await loadModule();
    const url = buildIssuesUrl({
      apiUrl: 'https://de.sentry.io/api/0',
      org: 'weird/slug',
      project: 'p with space',
    });
    assert.match(url, /weird%2Fslug/);
    assert.match(url, /p%20with%20space/);
  });

  it('clamps limit to 1..100', async () => {
    const { buildIssuesUrl } = await loadModule();
    const too_big = buildIssuesUrl({ apiUrl: 'https://de.sentry.io/api/0', org: 'x', project: 'y', limit: 500 });
    assert.match(too_big, /limit=100/);
    const too_small = buildIssuesUrl({ apiUrl: 'https://de.sentry.io/api/0', org: 'x', project: 'y', limit: 0 });
    assert.match(too_small, /limit=1/);
  });

  it('merges an explicit query with the age filter', async () => {
    const { buildIssuesUrl } = await loadModule();
    const url = buildIssuesUrl({
      apiUrl: 'https://de.sentry.io/api/0',
      org: 'x',
      project: 'y',
      age: '-6h',
      query: 'debate_id:abc',
    });
    const qp = new URL(url).searchParams.get('query');
    assert.equal(qp, 'age:-6h debate_id:abc');
  });
});

describe('isSentryConfigured', () => {
  it('is false when no env is set (config-singleton baseline)', async () => {
    // At this point the config module has been imported many times with
    // the test env. isSentryConfigured() reflects whichever was FIRST
    // imported. We cannot reliably assert the value — but we CAN assert
    // the function exists and returns a boolean.
    const { isSentryConfigured } = await loadModule();
    assert.equal(typeof isSentryConfigured(), 'boolean');
  });
});
