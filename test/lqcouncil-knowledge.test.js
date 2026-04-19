// test/lqcouncil-knowledge.test.js — knowledge loader + retrieval.
//
// Exercises the real curated data/lqcouncil-knowledge.json so the coverage
// test (10 archetypal questions) has verifiable grounding.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRelevantChunks,
  getChunkById,
  getAllChunks,
  buildKnowledgeIndexBlock,
  resetKnowledgeCacheForTests,
} from '../src/lqcouncil/knowledge.js';

describe('lqcouncil knowledge loader', () => {
  it('loads the curated corpus with 10+ chunks', () => {
    resetKnowledgeCacheForTests();
    const all = getAllChunks();
    assert.ok(all.length >= 10, `expected >= 10 curated chunks, got ${all.length}`);
    for (const c of all) {
      assert.ok(typeof c.id === 'string' && c.id.length > 0, `chunk missing id: ${JSON.stringify(c).slice(0, 80)}`);
      assert.ok(typeof c.title === 'string' && c.title.length > 0, `chunk ${c.id} missing title`);
      assert.ok(Array.isArray(c.keywords) && c.keywords.length > 0, `chunk ${c.id} has no keywords`);
      assert.ok(typeof c.content === 'string' && c.content.length > 100, `chunk ${c.id} content too short`);
    }
  });

  it('getChunkById returns exact match or null', () => {
    assert.ok(getChunkById('onboarding'));
    assert.equal(getChunkById('nonexistent-topic'), null);
    assert.equal(getChunkById(''), null);
    assert.equal(getChunkById(null), null);
  });

  it('finds the onboarding chunk for the archetypal "how do people prepare agents to join" question', () => {
    const hits = findRelevantChunks('how do people need to prepare their agents to join lqcouncil');
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes('onboarding'), `expected 'onboarding' in top hits, got ${ids.join(', ')}`);
    assert.ok(hits[0].score > 0);
  });

  it('finds the response-schema chunk for "what fields must my response include"', () => {
    const hits = findRelevantChunks('what fields must my DebateRoundResponse include');
    const ids = hits.map((h) => h.id);
    assert.ok(
      ids.includes('response-schema') || ids.includes('rounds'),
      `expected response-schema in top hits, got ${ids.join(', ')}`,
    );
  });

  it('finds the confidence-and-scoring chunk for the 0-100 question', () => {
    const hits = findRelevantChunks('why does confidence have to be 0-100 not 0-1');
    const ids = hits.map((h) => h.id);
    assert.ok(
      ids.includes('confidence-and-scoring'),
      `expected confidence-and-scoring in top hits, got ${ids.join(', ')}`,
    );
  });

  it('finds the error-taxonomy chunk for schema-error questions', () => {
    const hits = findRelevantChunks("I'm getting smoke_test_failed: missing response field");
    const ids = hits.map((h) => h.id);
    assert.ok(
      ids.includes('error-taxonomy') || ids.includes('response-schema'),
      `expected error-taxonomy or response-schema, got ${ids.join(', ')}`,
    );
  });

  it('respects the token budget', () => {
    const hits = findRelevantChunks('onboarding rounds schema response roles confidence error', { maxTokens: 500 });
    const total = hits.reduce((sum, h) => {
      const c = getChunkById(h.id);
      return sum + (c.tokens_estimate ?? 0);
    }, 0);
    // Allow the first chunk to exceed budget by itself (always returns at least one if matched).
    assert.ok(hits.length <= 2, `token-budget should cap at 2 chunks for 500-token budget, got ${hits.length}`);
    if (hits.length > 1) {
      assert.ok(total <= 500 + Math.max(...hits.map((h) => getChunkById(h.id).tokens_estimate ?? 0)), 'multi-chunk total exceeded budget');
    }
  });

  it('returns empty array for a query that matches nothing', () => {
    const hits = findRelevantChunks('xyzzy qwerty asdfgh');
    assert.deepEqual(hits, []);
  });

  it('buildKnowledgeIndexBlock lists every chunk id', () => {
    const block = buildKnowledgeIndexBlock();
    assert.ok(block.length > 0);
    for (const c of getAllChunks()) {
      assert.ok(block.includes(`\`${c.id}\``), `index block missing ${c.id}`);
    }
    // Behavioural guidance must be present so the LLM knows how to use it.
    assert.ok(/lqc_\*/.test(block), 'index block must hint at lqc_* tool preference');
  });
});
