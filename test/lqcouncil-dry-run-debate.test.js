// test/lqcouncil-dry-run-debate.test.js — Phase 4b: lqc_dry_run_debate.
//
// Exercises the tool against a local fake bot server so we test real HTTP
// semantics (status codes, body parsing, schema validation) without touching
// the network.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// lqcouncil tools transitively import config; satisfy Zod's minimum.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const { lqcDryRunDebate } = await import('../src/tools/lqcouncil.js');

function startFakeBot(responder) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          responder(req, res, parsed);
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/debate` });
    });
  });
}

describe('lqc_dry_run_debate', () => {
  let fakeBot = null;
  let requestCount = 0;
  let lastReceived = null;

  before(async () => {
    fakeBot = await startFakeBot((req, res, parsed) => {
      requestCount++;
      lastReceived = { headers: req.headers, body: parsed, url: req.url };
      // default: respond with valid schema
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'My initial position is X because Y.' }));
    });
  });

  after(() => {
    fakeBot.server.close();
  });

  it('posts a well-formed round-0 body with bearer auth', async () => {
    requestCount = 0;
    lastReceived = null;
    const out = await lqcDryRunDebate({
      endpoint_url: fakeBot.url,
      token: 'secret-bot-token',
      topic: 'AI regulation is inevitable',
    });
    assert.equal(requestCount, 1);
    assert.equal(lastReceived.headers['authorization'], 'Bearer secret-bot-token');
    assert.equal(lastReceived.body.round, 0);
    assert.equal(lastReceived.body.role, 'proponent');
    assert.ok(lastReceived.body.session_id.startsWith('clint-dry-run-'));
    assert.deepEqual(lastReceived.body.context, []);
    assert.match(lastReceived.body.prompt, /AI regulation is inevitable/);
    assert.match(lastReceived.body.prompt, /Your role: proponent/);
    assert.match(out, /Dry-run PASS/);
    assert.match(out, /My initial position is X/);
  });

  it('reports missing required params', async () => {
    assert.match(await lqcDryRunDebate({}), /endpoint_url.*required/);
    assert.match(await lqcDryRunDebate({ endpoint_url: 'x' }), /token.*required/);
    assert.match(await lqcDryRunDebate({ endpoint_url: 'x', token: 'y' }), /topic.*required/);
  });

  it('surfaces schema errors when the bot returns wrong shape', async () => {
    const bad = await startFakeBot((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'oops wrong field' }));
    });
    try {
      const out = await lqcDryRunDebate({
        endpoint_url: bad.url,
        token: 'x',
        topic: 'test',
      });
      assert.match(out, /Dry-run FAIL/);
      assert.match(out, /missing or non-string `response` field/);
    } finally {
      bad.server.close();
    }
  });

  it('flags non-integer confidence', async () => {
    const badConf = await startFakeBot((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: 'ok', confidence: 0.7 }));
    });
    try {
      const out = await lqcDryRunDebate({
        endpoint_url: badConf.url,
        token: 'x',
        topic: 'test',
      });
      assert.match(out, /confidence must be an integer/);
    } finally {
      badConf.server.close();
    }
  });

  it('surfaces non-2xx responses with the body', async () => {
    const err500 = await startFakeBot((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('internal server boom');
    });
    try {
      const out = await lqcDryRunDebate({
        endpoint_url: err500.url,
        token: 'x',
        topic: 'test',
      });
      assert.match(out, /HTTP 500/);
      assert.match(out, /Non-2xx response/);
      assert.match(out, /internal server boom/);
    } finally {
      err500.server.close();
    }
  });

  it('handles a bot that returns non-JSON', async () => {
    const nonJson = await startFakeBot((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json at all');
    });
    try {
      const out = await lqcDryRunDebate({
        endpoint_url: nonJson.url,
        token: 'x',
        topic: 'test',
      });
      assert.match(out, /Response was not valid JSON/);
    } finally {
      nonJson.server.close();
    }
  });
});
