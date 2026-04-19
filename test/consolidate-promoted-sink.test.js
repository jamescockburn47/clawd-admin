// test/consolidate-promoted-sink.test.js — shadow→promoted cutover.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

async function loadModule(relPath) {
  const url = pathToFileURL(join(process.cwd(), relPath)).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

const candidate = {
  text: 'James prefers meetings booked at 3pm on Fridays.',
  category: 'preference',
  confidence: 0.8,
  sources: [{ hash: 'sha256:abc123def456', excerpt: 'friday 3pm works' }],
};

describe('PromotedSink', () => {
  it('maps a validated candidate through to storeMemory with evidence tags', async () => {
    const { PromotedSink } = await loadModule('src/overnight/consolidate-promoted-sink.ts');
    const calls = [];
    const sink = new PromotedSink({
      deps: {
        storeMemory: async (fact, category, tags, confidence, source) => {
          calls.push({ fact, category, tags, confidence, source });
          return { stored: true };
        },
      },
    });

    await sink.storeValidated(candidate);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.fact, 'James prefers meetings booked at 3pm on Fridays.');
    assert.equal(call.category, 'preference');
    assert.equal(call.confidence, 0.8);
    assert.equal(call.source, 'consolidate-promoted');
    // Evidence tag carries a prefix of the source hash.
    assert.ok(call.tags.some((t) => t.startsWith('src:')), 'expected evidence-ref tag');
  });

  it('stamps chatJid tag when provided', async () => {
    const { PromotedSink } = await loadModule('src/overnight/consolidate-promoted-sink.ts');
    let captured = null;
    const sink = new PromotedSink({
      chatJid: '120363409858920612@g.us',
      deps: {
        storeMemory: async (fact, category, tags) => {
          captured = tags;
          return { stored: true };
        },
      },
    });
    await sink.storeValidated(candidate);
    assert.ok(captured.some((t) => t === 'chat:120363409858920612@g.us'));
  });

  it('queued result (offline) is not treated as failure', async () => {
    const { PromotedSink } = await loadModule('src/overnight/consolidate-promoted-sink.ts');
    const sink = new PromotedSink({
      deps: {
        storeMemory: async () => ({ stored: false, queued: true }),
      },
    });
    await assert.doesNotReject(sink.storeValidated(candidate));
  });

  it('throws when storeMemory returns an error field', async () => {
    const { PromotedSink } = await loadModule('src/overnight/consolidate-promoted-sink.ts');
    const sink = new PromotedSink({
      deps: {
        storeMemory: async () => ({ error: 'rate_limit' }),
      },
    });
    await assert.rejects(() => sink.storeValidated(candidate), /rate_limit/);
  });
});

describe('selectStoreClient', () => {
  const baseDeps = {
    overnightDir: '/tmp/overnight',
    logDir: '/tmp/logs',
    repoRoot: '/tmp',
    extractClient: { extractCandidates: async () => ({ candidates: [] }) },
    memoryClient: { triggerMaintenance: async () => ({ expired: 0, deduplicated: 0, total_after: 0 }) },
    topicClient: { indexDayTopics: async () => 0, pruneTopicIndex: async () => 0 },
    promotedSinkDeps: { storeMemory: async () => ({ stored: true }) },
  };
  const savedMode = process.env.CONSOLIDATE_MODE;
  afterEach(() => { process.env.CONSOLIDATE_MODE = savedMode ?? ''; });

  it('CONSOLIDATE_MODE=shadow returns ShadowSink', async () => {
    process.env.CONSOLIDATE_MODE = 'shadow';
    const { selectStoreClient } = await loadModule('src/overnight/consolidate-shadow-task.ts');
    const sink = selectStoreClient(baseDeps, '2026-04-19');
    assert.equal(sink.constructor.name, 'ShadowSink');
  });

  it('CONSOLIDATE_MODE=promoted returns PromotedSink', async () => {
    process.env.CONSOLIDATE_MODE = 'promoted';
    const { selectStoreClient } = await loadModule('src/overnight/consolidate-shadow-task.ts');
    const sink = selectStoreClient(baseDeps, '2026-04-19');
    assert.equal(sink.constructor.name, 'PromotedSink');
  });

  it('default (unset) returns PromotedSink — post-cutover default', async () => {
    delete process.env.CONSOLIDATE_MODE;
    const { selectStoreClient } = await loadModule('src/overnight/consolidate-shadow-task.ts');
    const sink = selectStoreClient(baseDeps, '2026-04-19');
    assert.equal(sink.constructor.name, 'PromotedSink');
  });

  it('falls back to ShadowSink when promoted requested but deps missing', async () => {
    process.env.CONSOLIDATE_MODE = 'promoted';
    const { selectStoreClient } = await loadModule('src/overnight/consolidate-shadow-task.ts');
    const deps = { ...baseDeps, promotedSinkDeps: undefined };
    const sink = selectStoreClient(deps, '2026-04-19');
    assert.equal(sink.constructor.name, 'ShadowSink');
  });
});
