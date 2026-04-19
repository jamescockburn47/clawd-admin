// test/lqcouncil-sentry-webhook.test.js — HMAC verification + alert formatting.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

// Set env before the module imports config transitively (happens at the
// dynamic-import site inside handleSentryWebhookRequest — the top-level
// import below pulls pure functions only).
before(() => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';
});

const {
  verifySentrySignature,
  formatSentryAlert,
} = await import('../src/lqcouncil/sentry-webhook.js');

describe('sentry-webhook.verifySentrySignature', () => {
  const SECRET = 'test-secret-do-not-use-in-prod';

  it('accepts a correctly-signed body', () => {
    const body = '{"hello":"world"}';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(verifySentrySignature(body, sig, SECRET), true);
  });

  it('rejects when the body was tampered with', () => {
    const body = '{"hello":"world"}';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(verifySentrySignature('{"hello":"evil"}', sig, SECRET), false);
  });

  it('rejects with a wrong secret', () => {
    const body = '{"hello":"world"}';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(verifySentrySignature(body, sig, 'different-secret'), false);
  });

  it('fails closed when secret is empty', () => {
    const body = '{"hello":"world"}';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    assert.equal(verifySentrySignature(body, sig, ''), false);
  });

  it('rejects missing signature', () => {
    assert.equal(verifySentrySignature('{"a":1}', null, SECRET), false);
    assert.equal(verifySentrySignature('{"a":1}', '', SECRET), false);
  });
});

describe('sentry-webhook.formatSentryAlert', () => {
  function makePayload({ title = 'TypeError: nope', level = 'error', lastSeen = new Date().toISOString(), tags = [], url = 'https://sentry.io/org/proj/issues/123/' } = {}) {
    return {
      action: 'created',
      data: {
        issue: {
          id: '123',
          title,
          culprit: 'src/api/bots.rs:42 in approve_bot',
          project: 'bot-council-backend',
          level,
          lastSeen,
          tags,
          web_url: url,
        },
      },
    };
  }

  it('formats a new issue with tags into a readable block', () => {
    const payload = makePayload({
      tags: [
        ['debate_id', 'deb-abc'],
        ['bot_id', 'bot-xyz'],
        ['error_kind', 'schema_missing_field'],
        ['release', 'abcd1234'],
      ],
    });
    const out = formatSentryAlert(payload);
    assert.ok(out, 'expected a formatted string');
    assert.match(out, /LQ Council Sentry: error/);
    assert.match(out, /TypeError: nope/);
    assert.match(out, /debate: deb-abc/);
    assert.match(out, /bot: bot-xyz/);
    assert.match(out, /kind: schema_missing_field/);
    assert.match(out, /release: abcd1234/);
    assert.match(out, /lqc_why_failed deb-abc/);
  });

  it('drops stale payloads (lastSeen older than 10 minutes)', () => {
    const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const payload = makePayload({ lastSeen: old });
    assert.equal(formatSentryAlert(payload), null);
  });

  it('returns null for malformed payload', () => {
    assert.equal(formatSentryAlert(null), null);
    assert.equal(formatSentryAlert({}), null);
    assert.equal(formatSentryAlert({ data: {} }), null);
  });

  it('handles tags as {key,value} objects as well as [key,value] tuples', () => {
    const payload = makePayload({
      tags: [
        { key: 'debate_id', value: 'deb-obj' },
        { key: 'bot_id', value: 'bot-obj' },
      ],
    });
    const out = formatSentryAlert(payload);
    assert.match(out, /debate: deb-obj/);
    assert.match(out, /bot: bot-obj/);
  });
});
