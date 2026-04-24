// test/semantic-diff.test.js — LLM-assisted drift impact assessment.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  assessDriftImpact,
  loadChunksByIds,
  formatChangeForPrompt,
} = await import('../src/lqcouncil/semantic-diff.js');

function mockGrader(body) {
  return {
    json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
  };
}

describe('loadChunksByIds', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sd-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns the requested chunks from a knowledge file', () => {
    const k = join(tmp, 'knowledge.json');
    writeFileSync(k, JSON.stringify({
      chunks: [
        { id: 'onboarding', title: 'How to sign up', content: 'Steps...' },
        { id: 'rounds', title: 'Rounds', content: 'Five rounds...' },
        { id: 'errors', title: 'Errors', content: 'Closed set...' },
      ],
    }));
    const out = loadChunksByIds(['onboarding', 'rounds'], k);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, 'onboarding');
    assert.equal(out[1].id, 'rounds');
  });

  it('skips missing chunk IDs silently', () => {
    const k = join(tmp, 'k.json');
    writeFileSync(k, JSON.stringify({ chunks: [{ id: 'a', content: 'A' }] }));
    assert.deepEqual(loadChunksByIds(['a', 'missing'], k).map((c) => c.id), ['a']);
  });

  it('returns empty when the knowledge file is missing', () => {
    assert.deepEqual(loadChunksByIds(['x'], join(tmp, 'nope.json')), []);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(loadChunksByIds([], join(tmp, 'irrelevant')), []);
    assert.deepEqual(loadChunksByIds(null, join(tmp, 'irrelevant')), []);
  });
});

describe('formatChangeForPrompt', () => {
  it('formats an array-diff compactly', () => {
    const out = formatChangeForPrompt({
      kind: 'array-diff', field: 'roles',
      added: ['Mediator'], removed: [],
    });
    assert.match(out, /roles/);
    assert.match(out, /Mediator/);
  });

  it('formats an api-routes-diff with added/removed/changed', () => {
    const out = formatChangeForPrompt({
      kind: 'api-routes-diff',
      added: ['/api/x [get]'], removed: ['/api/y [get]'], changed: ['/api/z [get]→[get,post]'],
    });
    assert.match(out, /\/api\/x/);
    assert.match(out, /\/api\/y/);
    assert.match(out, /\/api\/z/);
  });

  it('formats a scalar-diff', () => {
    const out = formatChangeForPrompt({
      kind: 'scalar-diff', field: 'roundTimeoutSeconds', old: 300, new: 240,
    });
    assert.match(out, /roundTimeoutSeconds/);
    assert.match(out, /300/);
    assert.match(out, /240/);
  });

  it('returns a graceful fallback for null', () => {
    assert.match(formatChangeForPrompt(null), /no change/);
  });
});

describe('assessDriftImpact', () => {
  const change = { kind: 'array-diff', field: 'apiRoutes', added: ['/api/stats'], removed: [] };
  const chunks = [{ id: 'onboarding', title: 'Sign-up', content: 'visit /bots/guide' }];

  it('parses a well-formed LLM response', async () => {
    const r = await assessDriftImpact({
      change, chunks,
      fetchFn: async () => mockGrader({
        severity: 'low',
        rationale: 'admin metric unrelated to onboarding',
        chunks_to_revise: [],
        suggested_edits: '',
      }),
    });
    assert.equal(r.severity, 'low');
    assert.match(r.rationale, /admin metric/);
    assert.deepEqual(r.chunks_to_revise, []);
  });

  it('keeps proposal alive (defaults to medium) when grader throws', async () => {
    const r = await assessDriftImpact({
      change, chunks,
      fetchFn: async () => { throw new Error('offline'); },
    });
    assert.equal(r.severity, 'medium');
    assert.match(r.rationale, /semantic-diff unavailable/);
  });

  it('defaults to medium on non-JSON grader output', async () => {
    const r = await assessDriftImpact({
      change, chunks,
      fetchFn: async () => ({ json: async () => ({ choices: [{ message: { content: 'nonsense' } }] }) }),
    });
    assert.equal(r.severity, 'medium');
    assert.match(r.rationale, /assess_no_json_block/);
  });

  it('clamps unknown severity to medium (safe side — keep proposal)', async () => {
    const r = await assessDriftImpact({
      change, chunks,
      fetchFn: async () => mockGrader({
        severity: 'critical', // not in our allowlist
        rationale: 'x',
        chunks_to_revise: ['onboarding'],
      }),
    });
    assert.equal(r.severity, 'medium');
  });

  it('returns "none" when LLM rules change unrelated', async () => {
    const r = await assessDriftImpact({
      change, chunks,
      fetchFn: async () => mockGrader({
        severity: 'none',
        rationale: 'new admin-only endpoint; not covered in onboarding prose',
        chunks_to_revise: [],
      }),
    });
    assert.equal(r.severity, 'none');
    assert.match(r.rationale, /admin-only/);
  });

  it('extracts JSON even when wrapped in narrative', async () => {
    const r = await assessDriftImpact({
      change, chunks,
      fetchFn: async () => ({
        json: async () => ({
          choices: [{ message: { content: 'Looking at the change: {"severity":"high","rationale":"stale url","chunks_to_revise":["onboarding"],"suggested_edits":"update /bots/submit → /bots/guide"} — that\'s the answer.' } }],
        }),
      }),
    });
    assert.equal(r.severity, 'high');
    assert.deepEqual(r.chunks_to_revise, ['onboarding']);
  });
});
