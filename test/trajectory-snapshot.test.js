// test/trajectory-snapshot.test.js — tool-trajectory assertion runner.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  loadTrajectoryCorpus,
  evaluateTrajectory,
  runTrajectorySnapshots,
  checkTrajectorySnapshots,
  resetTrajectoryStateForTests,
} = await import('../src/tasks/trajectory-snapshot.js');

describe('loadTrajectoryCorpus', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'traj-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('loads a well-formed corpus', () => {
    const path = join(tmp, 'corpus.json');
    writeFileSync(path, JSON.stringify({
      prompts: [{ id: 'q1', question: 'hi', must_contain_any: ['memory_search'] }],
    }));
    const corpus = loadTrajectoryCorpus(path);
    assert.equal(corpus.prompts.length, 1);
  });

  it('throws when corpus missing', () => {
    assert.throws(() => loadTrajectoryCorpus(join(tmp, 'nope.json')), /not found/);
  });

  it('throws when corpus has no prompts', () => {
    const path = join(tmp, 'empty.json');
    writeFileSync(path, JSON.stringify({ prompts: [] }));
    assert.throws(() => loadTrajectoryCorpus(path), /no prompts/);
  });

  it('loads the real production corpus', () => {
    const corpus = loadTrajectoryCorpus();
    assert.ok(corpus.prompts.length >= 4, 'production corpus has prompts');
    for (const p of corpus.prompts) {
      assert.ok(p.id, 'every prompt has id');
      assert.ok(p.question, 'every prompt has question');
    }
  });
});

describe('evaluateTrajectory', () => {
  it('passes when required tool was called', () => {
    const v = evaluateTrajectory(
      { must_contain_any: ['memory_search'] },
      ['memory_search'],
    );
    assert.equal(v.pass, true);
  });

  it('passes when one of several required tools was called', () => {
    const v = evaluateTrajectory(
      { must_contain_any: ['lqc_self_describe', 'lqc_bot_author_guide'] },
      ['lqc_bot_author_guide'],
    );
    assert.equal(v.pass, true);
  });

  it('fails when no required tool was called', () => {
    const v = evaluateTrajectory(
      { must_contain_any: ['memory_search'] },
      ['web_search'],
    );
    assert.equal(v.pass, false);
    assert.ok(v.failures[0].includes('missing_required_tool'));
  });

  it('fails when a forbidden tool fired', () => {
    const v = evaluateTrajectory(
      { must_not_contain: ['gmail_draft'] },
      ['memory_search', 'gmail_draft'],
    );
    assert.equal(v.pass, false);
    assert.ok(v.failures[0].includes('forbidden_tool_fired: gmail_draft'));
  });

  it('accumulates multiple failures', () => {
    const v = evaluateTrajectory(
      { must_contain_any: ['memory_search'], must_not_contain: ['gmail_draft', 'todo_add'] },
      ['web_search', 'gmail_draft', 'todo_add'],
    );
    assert.equal(v.pass, false);
    assert.equal(v.failures.length, 3);  // missing + 2 forbidden
  });

  it('enforces tool_count_max=0 for pure-knowledge prompts', () => {
    const v0 = evaluateTrajectory({ tool_count_max: 0 }, []);
    assert.equal(v0.pass, true);
    const v1 = evaluateTrajectory({ tool_count_max: 0 }, ['web_search']);
    assert.equal(v1.pass, false);
    assert.ok(v1.failures[0].includes('tool_count_exceeded'));
  });

  it('empty assertions on no-tool prompts still pass', () => {
    const v = evaluateTrajectory(
      { must_contain_any: [], must_not_contain: [] },
      [],
    );
    assert.equal(v.pass, true);
  });
});

describe('runTrajectorySnapshots — end-to-end', () => {
  let tmp;
  let corpusPath, resultsDir, proposalsDir;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'traj-run-'));
    corpusPath = join(tmp, 'corpus.json');
    resultsDir = join(tmp, 'snapshots');
    proposalsDir = join(tmp, 'proposals');
    writeFileSync(corpusPath, JSON.stringify({
      version: '1.0',
      prompts: [
        { id: 'recall', question: 'has X said Y', must_contain_any: ['memory_search'], must_not_contain: ['gmail_draft'] },
        { id: 'smalltalk', question: 'how are you', must_contain_any: [], must_not_contain: ['web_search'], tool_count_max: 0 },
      ],
    }));
    resetTrajectoryStateForTests();
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('passes when every prompt exhibits expected tool trajectory', async () => {
    let call = 0;
    const toolsPerCall = [['memory_search'], []];
    const responderFn = async () => ({ text: 'ok', meta: null });
    const getLastToolsCalledFn = () => toolsPerCall[call++] || [];
    const summary = await runTrajectorySnapshots({
      corpusPath, resultsDir, proposalsDir, responderFn, getLastToolsCalledFn,
    });
    assert.equal(summary.passed, 2);
    assert.equal(summary.failed, 0);
    const files = readdirSync(resultsDir).filter((f) => f.startsWith('snapshot-'));
    assert.equal(files.length, 1);
  });

  it('writes a regression proposal when any trajectory fails', async () => {
    let call = 0;
    // First prompt calls web_search (wrong; expected memory_search). Second calls gmail_draft (forbidden).
    const toolsPerCall = [['web_search'], ['gmail_draft']];
    const responderFn = async () => ({ text: 'ok', meta: null });
    const getLastToolsCalledFn = () => toolsPerCall[call++] || [];
    const summary = await runTrajectorySnapshots({
      corpusPath, resultsDir, proposalsDir, responderFn, getLastToolsCalledFn,
    });
    assert.equal(summary.failed, 2);
    const proposals = existsSync(proposalsDir) ? readdirSync(proposalsDir) : [];
    assert.ok(proposals.length >= 1, 'proposal should be written');
    const proposal = JSON.parse(readFileSync(join(proposalsDir, proposals[0]), 'utf8'));
    assert.equal(proposal.type, 'trajectory-drift');
    assert.equal(proposal.failed_count, 2);
    assert.ok(proposal.failing.every((f) => Array.isArray(f.failures) && f.failures.length > 0));
  });

  it('captures per-prompt tool sequences independently', async () => {
    let call = 0;
    const toolsPerCall = [['memory_search', 'web_search'], ['calendar_list']];  // both should pass filter
    const responderFn = async () => ({ text: 'ok', meta: null });
    const getLastToolsCalledFn = () => toolsPerCall[call++] || [];
    const summary = await runTrajectorySnapshots({
      corpusPath, resultsDir, proposalsDir, responderFn, getLastToolsCalledFn,
    });
    // First prompt should pass (memory_search called, no gmail_draft)
    assert.equal(summary.results[0].pass, true);
    assert.deepEqual(summary.results[0].toolsCalled, ['memory_search', 'web_search']);
    // Second prompt should fail (tool_count_max=0, but calendar_list fired)
    assert.equal(summary.results[1].pass, false);
    assert.deepEqual(summary.results[1].toolsCalled, ['calendar_list']);
  });
});

describe('checkTrajectorySnapshots — scheduler gate', () => {
  beforeEach(() => resetTrajectoryStateForTests());

  it('does not fire outside 03:45 slot', async () => {
    await checkTrajectorySnapshots('2026-04-24', 3, 44);
    await checkTrajectorySnapshots('2026-04-24', 4, 45);
    // No throw = pass
  });
});
