// src/tasks/trajectory-snapshot.js — nightly tool-trajectory checks.
//
// Complements golden-questions (which tests knowledge correctness).
// This task tests BEHAVIOUR: for a set of canonical prompts, does Clint
// still call the right CLASS of tool? Catches classifier re-routing
// (memory question → calendar tool) and tool-loop degradation
// (answering from stale internal state instead of calling
// memory_search).
//
// Soft assertion model:
//   - must_contain_any: at least ONE of the listed tools must fire
//   - must_not_contain: NONE of the listed tools may fire
//   - tool_count_max: optional cap (0 = no tools allowed)
//
// Schedule: nightly 03:45 London (15 min after golden-questions so
// prompt-cache on :8080 is already warm from those runs).
//
// SOTA alignment per 2026-04 research brief: "trajectory snapshot
// diffing" (bswen Agent Behavior Drift pattern). We don't need a
// full embedding-cluster baseline — a simple per-prompt tool-set
// assertion catches the classifier-regression class of bug.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';
import { appendEvent } from '../overnight/events.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..', '..');
const DEFAULT_CORPUS = join(REPO_ROOT, 'data', 'trajectory-baselines', 'clint.json');
const DEFAULT_RESULTS_DIR = join(REPO_ROOT, 'data', 'trajectory-snapshots');
const DEFAULT_PROPOSALS_DIR = join(REPO_ROOT, 'data', 'overnight', 'proposals');

export const TRAJECTORY_HOUR = 3;
export const TRAJECTORY_MINUTE = 45;

let lastRunDate = null;

export function resetTrajectoryStateForTests() {
  lastRunDate = null;
}

// ── Corpus loading ──────────────────────────────────────────────────

export function loadTrajectoryCorpus(path = DEFAULT_CORPUS) {
  if (!existsSync(path)) {
    throw new Error(`trajectory corpus not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length === 0) {
    throw new Error(`trajectory corpus has no prompts: ${path}`);
  }
  return parsed;
}

// ── Assertion evaluation ────────────────────────────────────────────

/**
 * Evaluate a single prompt's tool-trajectory assertions against the
 * observed tools called. Returns { pass, failures: [reason, ...] }.
 */
export function evaluateTrajectory(prompt, toolsCalled) {
  const failures = [];
  const calledSet = new Set(toolsCalled || []);

  // must_contain_any: at least ONE of these tools must have fired
  if (Array.isArray(prompt.must_contain_any) && prompt.must_contain_any.length > 0) {
    const hit = prompt.must_contain_any.some((t) => calledSet.has(t));
    if (!hit) {
      failures.push(`missing_required_tool: expected one of [${prompt.must_contain_any.join(', ')}], got [${[...calledSet].join(', ') || 'none'}]`);
    }
  }

  // must_not_contain: NONE of these may have fired (write-tool safety)
  if (Array.isArray(prompt.must_not_contain)) {
    for (const banned of prompt.must_not_contain) {
      if (calledSet.has(banned)) {
        failures.push(`forbidden_tool_fired: ${banned}`);
      }
    }
  }

  // tool_count_max: optional cap (0 = no tools; higher = strict limit)
  if (typeof prompt.tool_count_max === 'number' && (toolsCalled || []).length > prompt.tool_count_max) {
    failures.push(`tool_count_exceeded: expected ≤${prompt.tool_count_max}, got ${toolsCalled.length}`);
  }

  return { pass: failures.length === 0, failures };
}

// ── Runner ──────────────────────────────────────────────────────────

async function captureOneTrajectory({ prompt, responderFn, getLastToolsCalledFn }) {
  const synthSender = 'trajectory-test@test.clint';
  const synthChat = 'trajectory-test@test.clint';
  try {
    const result = await responderFn(prompt.question, 'direct', synthSender, null, synthChat, {});
    const toolsCalled = getLastToolsCalledFn ? [...(getLastToolsCalledFn() || [])] : [];
    return {
      text: result?.text ?? null,
      toolsCalled,
      meta: result?.meta ?? null,
    };
  } catch (err) {
    return { text: null, toolsCalled: [], meta: { error: err.message } };
  }
}

export async function runTrajectorySnapshots(opts = {}) {
  const corpus = opts.corpus || loadTrajectoryCorpus(opts.corpusPath || DEFAULT_CORPUS);
  const responderFn = opts.responderFn || (await import('../claude.js')).getClawdResponseResult;
  const getLastToolsCalledFn = opts.getLastToolsCalledFn || (await import('../claude.js')).getLastToolsCalled;
  const resultsDir = opts.resultsDir || DEFAULT_RESULTS_DIR;
  const proposalsDir = opts.proposalsDir || DEFAULT_PROPOSALS_DIR;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results = [];

  for (const p of corpus.prompts) {
    const trajectory = await captureOneTrajectory({
      prompt: p,
      responderFn,
      getLastToolsCalledFn,
    });
    const verdict = evaluateTrajectory(p, trajectory.toolsCalled);
    results.push({
      id: p.id,
      question: p.question,
      toolsCalled: trajectory.toolsCalled,
      responsePreview: (trajectory.text || '').slice(0, 200),
      meta: trajectory.meta,
      pass: verdict.pass,
      failures: verdict.failures,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const regressed = results.filter((r) => !r.pass);

  const summary = {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    corpusVersion: corpus.version,
    promptCount: corpus.prompts.length,
    passed,
    failed: regressed.length,
    results,
  };

  // Persist results.
  mkdirSync(resultsDir, { recursive: true });
  const dateStr = startedAt.slice(0, 10);
  const outPath = join(resultsDir, `snapshot-${dateStr}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // Proposal on any failure.
  let proposalPath = null;
  if (regressed.length > 0) {
    mkdirSync(proposalsDir, { recursive: true });
    const pfile = `trajectory-drift-${startedAt.replace(/[:.]/g, '-')}.json`;
    proposalPath = join(proposalsDir, pfile);
    writeFileSync(proposalPath, JSON.stringify({
      type: 'trajectory-drift',
      detected_at: startedAt,
      failed_count: regressed.length,
      failing: regressed.map((r) => ({
        id: r.id,
        question: r.question,
        toolsCalled: r.toolsCalled,
        failures: r.failures,
      })),
      recommended_action:
        'Review each failing trajectory. (a) Missing required tool → classifier may be re-routing; check recent router.js or cortex changes. (b) Forbidden tool fired → check tool-routing guards (e.g. group-tool-policy for owner-restricted tools leaking). (c) Tool count exceeded → check for runaway tool loops. If the expected behaviour has legitimately changed, update data/trajectory-baselines/clint.json.',
    }, null, 2) + '\n', 'utf8');
  }

  // Event log.
  try {
    await appendEvent({
      stage: 'operations',
      phase: 'trajectory-snapshot',
      inputs: [DEFAULT_CORPUS],
      outputs: proposalPath ? [outPath, proposalPath] : [outPath],
      verdict: regressed.length > 0 ? 'rejected' : 'ok',
      reason: `${passed}/${corpus.prompts.length} passed`,
      evidence_refs: regressed.map((r) => `fail:${r.id}`),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'trajectory-snapshot: event append failed');
  }

  return summary;
}

// ── Scheduler entry ─────────────────────────────────────────────────

export async function checkTrajectorySnapshots(todayStr, hours, minutes) {
  if (hours !== TRAJECTORY_HOUR || minutes !== TRAJECTORY_MINUTE) return;
  if (lastRunDate === todayStr) return;
  lastRunDate = todayStr;
  try {
    const summary = await runTrajectorySnapshots();
    logger.info({
      passed: summary.passed,
      failed: summary.failed,
      durationMs: summary.durationMs,
    }, 'trajectory-snapshot: nightly run complete');
  } catch (err) {
    logger.error({ err: err.message }, 'trajectory-snapshot: scheduled run failed');
  }
}
