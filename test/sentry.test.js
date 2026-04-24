// test/sentry.test.js — fetch-based Sentry envelope client.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  parseDsn,
  initSentry,
  isSentryEnabled,
  captureException,
  captureMessage,
  newTraceContext,
  injectTraceHeaders,
  setUser,
  resetSentryForTests,
} = await import('../src/sentry.js');

describe('parseDsn', () => {
  it('parses a valid DSN', () => {
    const out = parseDsn('https://abc123@o12.ingest.sentry.io/456');
    assert.ok(out);
    assert.equal(out.publicKey, 'abc123');
    assert.equal(out.projectId, '456');
    assert.equal(out.host, 'o12.ingest.sentry.io');
    assert.equal(out.ingestUrl, 'https://o12.ingest.sentry.io/api/456/envelope/');
  });

  it('parses an EU-region DSN', () => {
    const out = parseDsn('https://key@o99.ingest.de.sentry.io/1234');
    assert.equal(out.host, 'o99.ingest.de.sentry.io');
    assert.equal(out.ingestUrl, 'https://o99.ingest.de.sentry.io/api/1234/envelope/');
  });

  it('returns null on missing publicKey', () => {
    assert.equal(parseDsn('https://o12.ingest.sentry.io/456'), null);
  });

  it('returns null on missing projectId', () => {
    assert.equal(parseDsn('https://abc@o12.ingest.sentry.io/'), null);
  });

  it('returns null on empty / non-string input', () => {
    assert.equal(parseDsn(''), null);
    assert.equal(parseDsn(null), null);
    assert.equal(parseDsn(undefined), null);
    assert.equal(parseDsn(42), null);
  });

  it('returns null on malformed URL', () => {
    assert.equal(parseDsn('not-a-url'), null);
  });
});

describe('initSentry — disabled path', () => {
  beforeEach(() => { resetSentryForTests(); });
  afterEach(() => { resetSentryForTests(); delete process.env.SENTRY_DSN; });

  it('returns false when DSN unset', () => {
    delete process.env.SENTRY_DSN;
    const out = initSentry();
    assert.equal(out, false);
    assert.equal(isSentryEnabled(), false);
  });

  it('captureException is a no-op when disabled', async () => {
    resetSentryForTests();
    const out = await captureException(new Error('boom'));
    assert.equal(out, false);
  });

  it('captureMessage is a no-op when disabled', async () => {
    resetSentryForTests();
    const out = await captureMessage('hello');
    assert.equal(out, false);
  });

  it('injectTraceHeaders passes through unchanged when disabled', () => {
    resetSentryForTests();
    const headers = injectTraceHeaders({ 'x-test': '1' });
    assert.deepEqual(headers, { 'x-test': '1' });
  });
});

describe('initSentry — enabled path', () => {
  let origFetch;
  let lastFetchUrl;
  let lastFetchInit;
  let nextFetchResponse;

  beforeEach(() => {
    resetSentryForTests();
    lastFetchUrl = null;
    lastFetchInit = null;
    nextFetchResponse = { ok: true, status: 200 };
    origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      lastFetchUrl = url;
      lastFetchInit = init;
      return nextFetchResponse;
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    resetSentryForTests();
  });

  it('enables with a valid DSN', () => {
    const out = initSentry({ dsn: 'https://key@host.sentry.io/99', environment: 'test' });
    assert.equal(out, true);
    assert.equal(isSentryEnabled(), true);
  });

  it('captureException sends an envelope with exception payload', async () => {
    initSentry({ dsn: 'https://key@host.sentry.io/99' });
    const ok = await captureException(new Error('oh no'), { tags: { task: 'nightly' } });
    assert.equal(ok, true);
    assert.equal(lastFetchUrl, 'https://host.sentry.io/api/99/envelope/');
    assert.equal(lastFetchInit.method, 'POST');
    assert.equal(lastFetchInit.headers['Content-Type'], 'application/x-sentry-envelope');
    assert.match(lastFetchInit.headers['X-Sentry-Auth'], /sentry_key=key/);
    // Envelope body is three newline-separated JSON segments
    const parts = lastFetchInit.body.split('\n');
    assert.equal(parts.length, 3);
    const event = JSON.parse(parts[2]);
    assert.equal(event.exception.values[0].value, 'oh no');
    assert.equal(event.tags.task, 'nightly');
  });

  it('captureMessage sends a message-level event', async () => {
    initSentry({ dsn: 'https://key@host.sentry.io/99' });
    const ok = await captureMessage('deploy complete', 'info', { extra: { sha: 'abc' } });
    assert.equal(ok, true);
    const parts = lastFetchInit.body.split('\n');
    const event = JSON.parse(parts[2]);
    assert.equal(event.level, 'info');
    assert.equal(event.message.formatted, 'deploy complete');
    assert.equal(event.extra.sha, 'abc');
  });

  it('captureException returns false on fetch failure without throwing', async () => {
    initSentry({ dsn: 'https://key@host.sentry.io/99' });
    globalThis.fetch = async () => { throw new Error('network down'); };
    const ok = await captureException(new Error('something'));
    assert.equal(ok, false); // swallowed, didn't throw
  });

  it('setUser attaches user to subsequent events', async () => {
    initSentry({ dsn: 'https://key@host.sentry.io/99' });
    setUser({ id: 'jid@test', username: 'James' });
    await captureException(new Error('x'));
    const event = JSON.parse(lastFetchInit.body.split('\n')[2]);
    assert.equal(event.user.id, 'jid@test');
    assert.equal(event.user.username, 'James');
  });

  it('per-call user context overrides the default', async () => {
    initSentry({ dsn: 'https://key@host.sentry.io/99' });
    setUser({ id: 'default@test' });
    await captureException(new Error('x'), { user: { id: 'override@test' } });
    const event = JSON.parse(lastFetchInit.body.split('\n')[2]);
    assert.equal(event.user.id, 'override@test');
  });
});

describe('trace context + header injection', () => {
  beforeEach(() => {
    resetSentryForTests();
    initSentry({ dsn: 'https://k@h.sentry.io/1', environment: 'prod' });
  });
  afterEach(() => { resetSentryForTests(); });

  it('newTraceContext returns well-formed hex IDs', () => {
    const ctx = newTraceContext();
    assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
    assert.match(ctx.spanId, /^[0-9a-f]{16}$/);
    assert.match(ctx.sentryTrace, /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
    assert.match(ctx.baggage, /sentry-environment=prod/);
    assert.match(ctx.baggage, /sentry-trace_id=[0-9a-f]{32}/);
  });

  it('injectTraceHeaders adds sentry-trace + baggage when enabled', () => {
    const headers = injectTraceHeaders({ 'content-type': 'application/json' });
    assert.match(headers['sentry-trace'], /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
    assert.match(headers.baggage, /sentry-environment=prod/);
    assert.equal(headers['content-type'], 'application/json'); // preserved
  });

  it('newTraceContext produces distinct IDs on each call', () => {
    const a = newTraceContext();
    const b = newTraceContext();
    assert.notEqual(a.traceId, b.traceId);
    assert.notEqual(a.spanId, b.spanId);
  });
});
