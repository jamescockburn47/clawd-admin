// test/lqc-repo-poll.test.js — bot-council HEAD polling + drift trigger.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  fetchRemoteHead,
  pollRepoHead,
  checkRepoPoll,
  resetRepoPollStateForTests,
} = await import('../src/tasks/lqc-repo-poll.js');

describe('fetchRemoteHead', () => {
  it('returns sha, date, message on success', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        sha: 'abc1234567890abcdef',
        commit: { author: { date: '2026-04-23T10:00:00Z' }, message: 'hello' },
      }),
    });
    const head = await fetchRemoteHead({ owner: 'o', repo: 'r', branch: 'main', fetchFn });
    assert.equal(head.sha, 'abc1234567890abcdef');
    assert.equal(head.date, '2026-04-23T10:00:00Z');
    assert.equal(head.message, 'hello');
  });

  it('returns null on non-OK response', async () => {
    const fetchFn = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await fetchRemoteHead({ owner: 'o', repo: 'r', branch: 'main', fetchFn }), null);
  });

  it('returns null when response body lacks a sha', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ notASha: true }) });
    assert.equal(await fetchRemoteHead({ owner: 'o', repo: 'r', branch: 'main', fetchFn }), null);
  });

  it('returns null on network throw', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    assert.equal(await fetchRemoteHead({ owner: 'o', repo: 'r', branch: 'main', fetchFn }), null);
  });

  it('returns null when owner/repo/branch missing', async () => {
    assert.equal(await fetchRemoteHead({}), null);
  });
});

describe('pollRepoHead', () => {
  let tmp;
  let statePath;
  let driftCalls;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lqc-poll-'));
    statePath = join(tmp, 'state.json');
    driftCalls = [];
    resetRepoPollStateForTests();
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  const mkDrift = () => async (opts) => {
    driftCalls.push(opts);
    return { actionable: [], proposalPath: null, sourceAvailable: true };
  };
  const mkFetch = (head) => async () => ({
    ok: true,
    json: async () => ({ sha: head, commit: { author: { date: '2026-04-23T10:00:00Z' }, message: 'm' } }),
  });

  it('fires drift on first observed SHA and persists state', async () => {
    const out = await pollRepoHead({
      fetchFn: mkFetch('sha1'),
      runDrift: mkDrift(),
      statePath,
      repo: { owner: 'o', repo: 'r', branch: 'main' },
    });
    assert.equal(out.ok, true);
    assert.equal(out.reason, 'changed');
    assert.equal(out.sha, 'sha1');
    assert.equal(driftCalls.length, 1);
    assert.match(driftCalls[0].reason, /^repo-poll:sha1/);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.sha, 'sha1');
    assert.ok(state.lastChanged);
  });

  it('does NOT fire drift when SHA is unchanged', async () => {
    // Seed state at sha1
    writeFileSync(statePath, JSON.stringify({ sha: 'sha1', lastChecked: null, lastChanged: null }));
    const out = await pollRepoHead({
      fetchFn: mkFetch('sha1'),
      runDrift: mkDrift(),
      statePath,
      repo: { owner: 'o', repo: 'r', branch: 'main' },
    });
    assert.equal(out.reason, 'no-change');
    assert.equal(driftCalls.length, 0);
    // lastChecked should be updated, sha unchanged
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.sha, 'sha1');
    assert.ok(state.lastChecked);
  });

  it('fires drift when SHA advances', async () => {
    writeFileSync(statePath, JSON.stringify({ sha: 'sha1', lastChecked: null, lastChanged: null }));
    const out = await pollRepoHead({
      fetchFn: mkFetch('sha2'),
      runDrift: mkDrift(),
      statePath,
      repo: { owner: 'o', repo: 'r', branch: 'main' },
    });
    assert.equal(out.reason, 'changed');
    assert.equal(out.sha, 'sha2');
    assert.equal(driftCalls.length, 1);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.sha, 'sha2');
  });

  it('reports upstream-unreachable on fetch failure without touching state.sha', async () => {
    writeFileSync(statePath, JSON.stringify({ sha: 'sha1', lastChecked: null, lastChanged: null }));
    const out = await pollRepoHead({
      fetchFn: async () => { throw new Error('offline'); },
      runDrift: mkDrift(),
      statePath,
      repo: { owner: 'o', repo: 'r', branch: 'main' },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'upstream-unreachable');
    assert.equal(driftCalls.length, 0);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.sha, 'sha1');         // unchanged
    assert.ok(state.lastChecked);            // updated
  });

  it('continues and persists state even if drift check throws', async () => {
    const out = await pollRepoHead({
      fetchFn: mkFetch('sha1'),
      runDrift: async () => { throw new Error('drift boom'); },
      statePath,
      repo: { owner: 'o', repo: 'r', branch: 'main' },
    });
    assert.equal(out.reason, 'changed');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(state.sha, 'sha1');  // state still advanced so we don't retry forever
  });
});

describe('checkRepoPoll — scheduler gate', () => {
  beforeEach(() => { resetRepoPollStateForTests(); });

  it('does nothing outside 15-minute boundaries', async () => {
    let called = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return { ok: false }; };
    try {
      await checkRepoPoll('2026-04-23', 10, 7);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not double-fire within the same minute', async () => {
    // Can't really probe pollRepoHead without injection inside checkRepoPoll,
    // but we can at least verify the lastTickMinute guard by calling twice
    // and checking no exception is thrown. Network will fail silently.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
    try {
      await checkRepoPoll('2026-04-23', 10, 0);
      await checkRepoPoll('2026-04-23', 10, 0);  // same tick key — skipped
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
