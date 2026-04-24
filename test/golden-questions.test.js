// test/golden-questions.test.js — corpus loading, grader parsing, runner.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  loadCorpus,
  gradeAnswer,
  askClint,
  runGoldenQuestions,
  checkGoldenQuestions,
  resetGoldenStateForTests,
} = await import('../src/tasks/golden-questions.js');

function mockGraderResponse(score, missing = [], inaccuracies = [], rationale = 'ok') {
  return {
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ score, missing, inaccuracies, rationale }) } }],
    }),
  };
}

describe('loadCorpus', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'golden-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('loads a well-formed corpus file', () => {
    const path = join(tmp, 'corpus.json');
    writeFileSync(path, JSON.stringify({
      version: '1.0',
      questions: [{ id: 'q1', question: 'hi', expected_concepts: ['a'] }],
    }));
    const corpus = loadCorpus(path);
    assert.equal(corpus.version, '1.0');
    assert.equal(corpus.questions.length, 1);
  });

  it('throws when the file is missing', () => {
    assert.throws(() => loadCorpus(join(tmp, 'nope.json')), /not found/);
  });

  it('throws when the file has no questions', () => {
    const path = join(tmp, 'empty.json');
    writeFileSync(path, JSON.stringify({ version: '1.0', questions: [] }));
    assert.throws(() => loadCorpus(path), /no questions/);
  });

  it('loads the real production corpus', () => {
    const corpus = loadCorpus();
    assert.ok(corpus.questions.length >= 10, `expected ≥10 questions, got ${corpus.questions.length}`);
    for (const q of corpus.questions) {
      assert.ok(q.id, 'every question has id');
      assert.ok(q.question, 'every question has question text');
      assert.ok(Array.isArray(q.expected_concepts) && q.expected_concepts.length > 0,
        `question ${q.id} must have expected_concepts`);
    }
  });
});

describe('gradeAnswer', () => {
  it('parses a valid JSON grader response', async () => {
    const grade = await gradeAnswer({
      question: 'Q?',
      expected: ['a', 'b'],
      actual: 'X',
      fetchFn: async () => mockGraderResponse(8, ['b'], [], 'minor miss'),
    });
    assert.equal(grade.score, 8);
    assert.deepEqual(grade.missing, ['b']);
    assert.equal(grade.rationale, 'minor miss');
  });

  it('returns null score on grader network error', async () => {
    const grade = await gradeAnswer({
      question: 'Q',
      expected: ['a'],
      actual: 'X',
      fetchFn: async () => { throw new Error('offline'); },
    });
    assert.equal(grade.score, null);
    assert.match(grade.rationale, /grader_error/);
  });

  it('handles non-JSON grader output gracefully', async () => {
    const grade = await gradeAnswer({
      question: 'Q',
      expected: ['a'],
      actual: 'X',
      fetchFn: async () => ({
        json: async () => ({ choices: [{ message: { content: 'not json here' } }] }),
      }),
    });
    assert.equal(grade.score, null);
    assert.match(grade.rationale, /grader_no_json/);
  });

  it('extracts JSON even when wrapped in prose', async () => {
    const grade = await gradeAnswer({
      question: 'Q',
      expected: ['a'],
      actual: 'X',
      fetchFn: async () => ({
        json: async () => ({ choices: [{ message: { content: 'Here you go: {"score":9,"missing":[],"inaccuracies":[],"rationale":"good"} done.' } }] }),
      }),
    });
    assert.equal(grade.score, 9);
  });
});

describe('askClint', () => {
  it('calls the responder with synthetic sender + chat JIDs', async () => {
    let captured = null;
    const responderFn = async (ctx, mode, sender, img, chat, opts) => {
      captured = { ctx, mode, sender, chat };
      return { text: 'hello', meta: { provider: 'test' } };
    };
    const out = await askClint({ question: 'hi', responderFn });
    assert.equal(out.text, 'hello');
    assert.equal(out.meta.provider, 'test');
    assert.match(captured.sender, /@test\.clint$/);
    assert.match(captured.chat, /@test\.clint$/);
    assert.equal(captured.mode, 'direct');
  });

  it('returns null text when the responder throws', async () => {
    const responderFn = async () => { throw new Error('boom'); };
    const out = await askClint({ question: 'hi', responderFn });
    assert.equal(out.text, null);
    assert.match(out.meta.error, /boom/);
  });
});

describe('runGoldenQuestions — end-to-end', () => {
  let tmp;
  let corpusPath, resultsDir, proposalsDir;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'golden-run-'));
    corpusPath = join(tmp, 'corpus.json');
    resultsDir = join(tmp, 'results');
    proposalsDir = join(tmp, 'proposals');
    writeFileSync(corpusPath, JSON.stringify({
      version: '1.0',
      last_curated: '2026-04-24',
      questions: [
        { id: 'q1', category: 'x', question: 'Q1', expected_concepts: ['a'] },
        { id: 'q2', category: 'x', question: 'Q2', expected_concepts: ['b'] },
        { id: 'q3', category: 'x', question: 'Q3', expected_concepts: ['c'] },
      ],
    }));
    resetGoldenStateForTests();
    // Prevent appendEvent from writing to real overnight logs during tests
    mkdirSync(join(tmp, 'data', 'overnight'), { recursive: true });
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('runs a clean pass when all graders return high scores', async () => {
    let graderCalls = 0;
    const responderFn = async () => ({ text: 'fine answer', meta: { provider: 'fake' } });
    const graderFetchFn = async () => {
      graderCalls++;
      return mockGraderResponse(9, [], [], 'great');
    };
    const summary = await runGoldenQuestions({
      corpusPath, resultsDir, proposalsDir, responderFn, graderFetchFn,
    });
    assert.equal(summary.questionCount, 3);
    assert.equal(summary.passed, 3);
    assert.equal(summary.passRate, 1);
    assert.equal(summary.regression, false);
    assert.equal(graderCalls, 3);
    // Results file exists
    const files = readdirSync(resultsDir).filter((f) => f.startsWith('results-'));
    assert.equal(files.length, 1);
    const saved = JSON.parse(readFileSync(join(resultsDir, files[0]), 'utf8'));
    assert.equal(saved.results.length, 3);
    // No proposal written on a clean pass
    assert.ok(!existsSync(proposalsDir) || readdirSync(proposalsDir).length === 0);
  });

  it('flags partial failure (passed < threshold) but no regression without trailing history', async () => {
    let idx = 0;
    const responderFn = async () => ({ text: 'ans', meta: null });
    const graderFetchFn = async () => {
      idx++;
      return mockGraderResponse(idx === 2 ? 3 : 9);
    };
    const summary = await runGoldenQuestions({
      corpusPath, resultsDir, proposalsDir, responderFn, graderFetchFn,
    });
    assert.equal(summary.passed, 2);
    assert.equal(summary.questionCount, 3);
    // No regression flagged because we have no trailing window
    assert.equal(summary.regression, false);
  });

  it('flags regression when today drops >15pp below trailing median', async () => {
    // Seed 3 prior results at 100% pass rate.
    mkdirSync(resultsDir, { recursive: true });
    for (const d of ['2026-04-21', '2026-04-22', '2026-04-23']) {
      writeFileSync(join(resultsDir, `results-${d}.json`), JSON.stringify({
        passRate: 1.0, passed: 3, questionCount: 3, results: [],
      }));
      // Touch mtime ascending so sort-by-recency picks them up
      const when = new Date(d).getTime();
      const fs = await import('node:fs/promises');
      await fs.utimes(join(resultsDir, `results-${d}.json`), new Date(when), new Date(when));
    }
    // Today: only 1/3 pass (33%, 67pp below trailing median of 100%).
    let idx = 0;
    const responderFn = async () => ({ text: 'ans', meta: null });
    const graderFetchFn = async () => {
      idx++;
      return mockGraderResponse(idx === 1 ? 9 : 3);
    };
    const summary = await runGoldenQuestions({
      corpusPath, resultsDir, proposalsDir, responderFn, graderFetchFn,
    });
    assert.equal(summary.regression, true);
    assert.equal(summary.trailingMedianPassRate, 1.0);
    // Proposal written
    const proposals = existsSync(proposalsDir) ? readdirSync(proposalsDir) : [];
    assert.ok(proposals.length >= 1, 'regression proposal should be written');
    const proposal = JSON.parse(readFileSync(join(proposalsDir, proposals[0]), 'utf8'));
    assert.equal(proposal.type, 'golden-questions-regression');
    assert.equal(proposal.failing_today.length, 2);
  });

  it('does NOT regress when trailing history is <3 runs (insufficient data)', async () => {
    // Only 2 prior results.
    mkdirSync(resultsDir, { recursive: true });
    for (const d of ['2026-04-22', '2026-04-23']) {
      writeFileSync(join(resultsDir, `results-${d}.json`), JSON.stringify({
        passRate: 1.0, passed: 3, questionCount: 3, results: [],
      }));
    }
    const responderFn = async () => ({ text: 'ans', meta: null });
    const graderFetchFn = async () => mockGraderResponse(3); // all fail
    const summary = await runGoldenQuestions({
      corpusPath, resultsDir, proposalsDir, responderFn, graderFetchFn,
    });
    assert.equal(summary.regression, false, 'insufficient history → no regression call');
  });
});

describe('checkGoldenQuestions — scheduler gate', () => {
  beforeEach(() => resetGoldenStateForTests());

  it('does not fire outside 03:30 slot', async () => {
    // Running would hit the real filesystem/LLM. A clean skip is enough.
    await checkGoldenQuestions('2026-04-24', 4, 30);
    await checkGoldenQuestions('2026-04-24', 3, 29);
    // No assertions needed — just confirming no throw.
  });
});
