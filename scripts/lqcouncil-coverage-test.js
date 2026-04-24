#!/usr/bin/env node
// scripts/lqcouncil-coverage-test.js — deterministic Phase 3 coverage test.
//
// Exercises the curated knowledge corpus against the 10 archetypal bot-author
// questions from the Phase 3 plan. Prints, for each question, which chunks
// surface and what the matched keywords were. This is the "test transcript"
// the user reviews before declaring Phase 3 done — it shows WITHOUT an LLM
// call whether the material is actually in the corpus.
//
// Run: tsx scripts/lqcouncil-coverage-test.js
// Or:  node scripts/lqcouncil-coverage-test.js

import {
  findRelevantChunks,
  getChunkById,
  resetKnowledgeCacheForTests,
} from '../src/lqcouncil/knowledge.js';

const QUESTIONS = [
  { q: 'What do I need to do to get my bot admitted?', expect: ['onboarding'] },
  { q: 'Why does confidence have to be 0-100, not 0-1?', expect: ['confidence-and-scoring'] },
  { q: 'What fields must my DebateRoundResponse include?', expect: ['response-schema'] },
  { q: 'What does my bot receive in round 2?', expect: ['rounds', 'request-schema'] },
  { q: "I'm getting smoke_test_failed: missing response field. What's wrong?", expect: ['error-taxonomy', 'response-schema'] },
  { q: 'My bot uses GPT-5 internally. How do I pass the prompt through?', expect: ['llm-wrapping'] },
  { q: 'Do I have to handle all 5 rounds or can I abstain?', expect: ['abstention', 'rounds'] },
  { q: "What's a reasonable HTTP timeout on my bot's side?", expect: ['endpoint-contract'] },
  { q: 'How do I test my bot before submitting?', expect: ['test-before-submit'] },
  { q: 'My bot was approved but fails every debate. Why?', expect: ['error-taxonomy'] },
];

function runOne({ q, expect }) {
  const hits = findRelevantChunks(q, { maxChunks: 3, maxTokens: 1500 });
  const ids = hits.map((h) => h.id);
  const expectedHit = expect.some((e) => ids.includes(e));
  return {
    question: q,
    expected: expect,
    gotTopIds: ids,
    passed: expectedHit,
    topChunk: hits[0]
      ? {
          id: hits[0].id,
          title: hits[0].title,
          score: hits[0].score,
          matchedKeywords: hits[0].matchedKeywords,
          excerpt: getChunkById(hits[0].id).content.slice(0, 240).replace(/\n+/g, ' ') + '…',
        }
      : null,
    allScored: hits.map((h) => ({ id: h.id, score: h.score, matched: h.matchedKeywords })),
  };
}

function main() {
  resetKnowledgeCacheForTests();
  const results = QUESTIONS.map(runOne);

  console.log('='.repeat(72));
  console.log('LQcouncil Phase-3 coverage test — 10 archetypal bot-author questions');
  console.log('='.repeat(72));
  console.log('');

  for (const [i, r] of results.entries()) {
    const pass = r.passed ? 'PASS' : 'FAIL';
    console.log(`[${i + 1}/10] ${pass}  ${r.question}`);
    console.log(`      expected one of: ${r.expected.join(', ')}`);
    console.log(`      got top ids:     ${r.gotTopIds.join(', ') || '(no hits)'}`);
    if (r.topChunk) {
      console.log(`      top: ${r.topChunk.id} (score ${r.topChunk.score}) — matched [${r.topChunk.matchedKeywords.join(' | ')}]`);
      console.log(`      excerpt: ${r.topChunk.excerpt}`);
    } else {
      console.log('      top: (none)');
    }
    console.log('');
  }

  const passed = results.filter((r) => r.passed).length;
  console.log('-'.repeat(72));
  console.log(`Coverage: ${passed}/${QUESTIONS.length} questions routed to an expected chunk.`);
  console.log('-'.repeat(72));
  if (passed < QUESTIONS.length) {
    process.exitCode = 1;
  }
}

main();
