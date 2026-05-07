// src/tasks/golden-questions.js — nightly knowledge contract tests.
//
// Every night runs a frozen corpus of Q&A pairs about LQcouncil through
// Clint's full response pipeline (classifier → cortex → 27B → tools →
// output) and grades the answers against hand-authored expected
// concepts. Alerts on regression — catches:
//
//   - Classifier re-routing wrong (e.g. "how do I sign up" now routes
//     to calendar)
//   - Curated knowledge drift (e.g. the /bots/guide page renamed and
//     Clint keeps parroting the old URL)
//   - Cortex filter regression (e.g. memory retrieval dropping the
//     relevant chunk)
//   - Subtle model degradation (e.g. after a Qwen upgrade, answers
//     skew shorter and miss concepts)
//
// SOTA alignment per 2026-04 research: Arize / Evidently "golden
// dataset" pattern for LLM-era apps. Corpus authored by humans, frozen
// per-curation-cycle, expected_concepts drive a rubric-style grade
// rather than exact-match comparison.
//
// Schedule: nightly 03:30 London (after 02:10 drift detector, before
// 07:00 morning briefing). Results land in
// data/golden-questions/results-<date>.json and the morning briefing /
// daily-health posts can surface the pass rate.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import logger from '../logger.js';
import { appendEvent } from '../overnight/events.js';
import { evoFetch } from '../evo-client.js';
import { TIMEOUTS } from '../constants.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, '..', '..');
const DEFAULT_CORPUS = join(REPO_ROOT, 'data', 'golden-questions', 'lqcouncil.json');
const DEFAULT_RESULTS_DIR = join(REPO_ROOT, 'data', 'golden-questions');
const DEFAULT_PROPOSALS_DIR = join(REPO_ROOT, 'data', 'overnight', 'proposals');

export const GOLDEN_HOUR = 3;
export const GOLDEN_MINUTE = 30;

// Pass thresholds. A question scores 0-10 on the rubric below; anything
// ≥7 counts as PASS. Regression proposal fires if overall pass-rate
// drops >15 percentage points below the trailing-3-run median (cheap
// statistical test for small samples — matches the SOTA research brief
// on low-volume anomaly detection).
const PASS_SCORE = 7;
const REGRESSION_MARGIN = 15;
const TRAILING_WINDOW = 3;

let lastRunDate = null;

export function resetGoldenStateForTests() {
  lastRunDate = null;
}

// ── Corpus loading ──────────────────────────────────────────────────

export function loadCorpus(path = DEFAULT_CORPUS) {
  if (!existsSync(path)) {
    throw new Error(`golden-questions corpus not found: ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error(`golden-questions corpus has no questions: ${path}`);
  }
  return parsed;
}

// ── Grader ──────────────────────────────────────────────────────────

const GRADER_SYSTEM_PROMPT = `You grade an AI assistant's answer against a list of expected concepts.

Score the answer 0-10 on coverage + accuracy:
  - 10 = all expected concepts covered, factually accurate
  - 7-9 = most concepts covered, minor misses acceptable
  - 4-6 = major concepts missing OR factual errors
  - 0-3 = wrong topic / hallucinated / no useful content

Return JSON only. No thinking, no explanation outside JSON.

Output shape:
{"score":N,"missing":["concept1","concept2"],"inaccuracies":["..."],"rationale":"one sentence"}`;

/**
 * Grade a single answer. Calls the local 27B via :8080 (same endpoint
 * the chat pipeline uses) so the grader runs on whatever model Clint
 * is running — lets the test ride alongside model changes rather than
 * silently anchoring on a separate grading model.
 */
export async function gradeAnswer(opts) {
  const { question, expected, actual, fetchFn = null } = opts;
  const userContent =
    `Question: ${question}\n\n` +
    `Expected concepts (the answer should cover most/all):\n` +
    expected.map((c, i) => `  ${i + 1}. ${c}`).join('\n') +
    `\n\nActual answer:\n${actual || '(no answer produced)'}\n/no_think`;

  let res;
  try {
    res = fetchFn
      ? await fetchFn()
      : await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
          method: 'POST',
          body: JSON.stringify({
            messages: [
              { role: 'system', content: GRADER_SYSTEM_PROMPT },
              { role: 'user', content: userContent },
            ],
            max_tokens: 400,
            temperature: 0,
            cache_prompt: true,
          }),
          timeout: TIMEOUTS.EVO_REQUEST,
        });
  } catch (err) {
    return { score: null, missing: [], inaccuracies: [], rationale: `grader_error: ${err.message}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { score: null, missing: [], inaccuracies: [], rationale: 'grader_response_not_json' };
  }
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, missing: [], inaccuracies: [], rationale: `grader_no_json: ${raw.slice(0, 100)}` };
  try {
    const parsed = JSON.parse(m[0]);
    return {
      score: typeof parsed.score === 'number' ? parsed.score : null,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      inaccuracies: Array.isArray(parsed.inaccuracies) ? parsed.inaccuracies : [],
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch (err) {
    return { score: null, missing: [], inaccuracies: [], rationale: `grader_parse_error: ${err.message}` };
  }
}

// ── Answer capture ──────────────────────────────────────────────────

/**
 * Ask Clint a question via the full response pipeline. Uses a synthetic
 * sender JID + chat JID so the test doesn't interfere with real
 * conversations. Owner-restricted tools (calendar / email / etc.) are
 * automatically blocked for the non-owner synthetic JID.
 *
 * Returns { text, meta } from getClawdResponseResult, or
 * { text: null, meta: { error } } on failure.
 */
export async function askClint({ question, responderFn }) {
  const synthSender = 'golden-questions@test.clint';
  // Use the LQC dev-group JID as the synthetic chat so the LQ-Council
  // knowledge fragment + tool guide are injected into the prompt (the
  // injection in src/prompt.js gates on chat being a group bound to the
  // lqcouncil project). Otherwise the bot answers blind and every LQC
  // signup/architecture question fails. getResponse does not push to
  // group buffers, so this does not pollute the real group state.
  const config = (await import('../config.js')).default;
  const synthChat = config.lqcDevGroupJid || 'golden-questions@test.clint';
  try {
    const result = await responderFn(question, 'direct', synthSender, null, synthChat, {});
    return { text: result?.text ?? null, meta: result?.meta ?? null };
  } catch (err) {
    return { text: null, meta: { error: err.message } };
  }
}

// ── Runner ──────────────────────────────────────────────────────────

export async function runGoldenQuestions(opts = {}) {
  const corpus = opts.corpus || loadCorpus(opts.corpusPath || DEFAULT_CORPUS);
  const responderFn = opts.responderFn || (await import('../claude.js')).getClawdResponseResult;
  const resultsDir = opts.resultsDir || DEFAULT_RESULTS_DIR;
  const proposalsDir = opts.proposalsDir || DEFAULT_PROPOSALS_DIR;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results = [];

  for (const q of corpus.questions) {
    const { text, meta } = await askClint({ question: q.question, responderFn });
    const grade = await gradeAnswer({
      question: q.question,
      expected: q.expected_concepts,
      actual: text,
      fetchFn: opts.graderFetchFn,
    });
    results.push({
      id: q.id,
      category: q.category,
      question: q.question,
      actual_preview: (text || '').slice(0, 400),
      meta: meta || null,
      grade,
      pass: (grade.score ?? 0) >= PASS_SCORE,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const graded = results.filter((r) => r.grade.score !== null).length;
  const passRate = corpus.questions.length > 0 ? passed / corpus.questions.length : 0;

  // Trailing regression check against last 3 runs' median pass rate.
  const trailing = readTrailingPassRates(resultsDir, TRAILING_WINDOW);
  const trailingMedian = median(trailing);
  const regression =
    trailing.length >= TRAILING_WINDOW &&
    trailingMedian !== null &&
    passRate * 100 < trailingMedian * 100 - REGRESSION_MARGIN;

  const summary = {
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    corpusVersion: corpus.version,
    corpusLastCurated: corpus.last_curated || null,
    questionCount: corpus.questions.length,
    graded,
    passed,
    passRate,
    trailingMedianPassRate: trailingMedian,
    regression,
    results,
  };

  // Persist results.
  mkdirSync(resultsDir, { recursive: true });
  const dateStr = startedAt.slice(0, 10);
  const outPath = join(resultsDir, `results-${dateStr}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // Proposal on regression.
  let proposalPath = null;
  if (regression) {
    mkdirSync(proposalsDir, { recursive: true });
    const pfile = `golden-questions-regression-${startedAt.replace(/[:.]/g, '-')}.json`;
    proposalPath = join(proposalsDir, pfile);
    writeFileSync(proposalPath, JSON.stringify({
      type: 'golden-questions-regression',
      detected_at: startedAt,
      pass_rate_today: passRate,
      trailing_median_pass_rate: trailingMedian,
      margin_below: (trailingMedian * 100 - passRate * 100).toFixed(1),
      failing_today: results.filter((r) => !r.pass).map((r) => ({
        id: r.id,
        category: r.category,
        score: r.grade.score,
        missing: r.grade.missing,
        inaccuracies: r.grade.inaccuracies,
        rationale: r.grade.rationale,
      })),
      recommended_action:
        'Review the failing questions. If expected_concepts are still correct, investigate: (a) classifier re-routing, (b) curated knowledge drift, (c) cortex memory regression, (d) model degradation. If the expected_concepts are now stale, update data/golden-questions/lqcouncil.json.',
    }, null, 2) + '\n', 'utf8');
  }

  // Event log.
  try {
    await appendEvent({
      stage: 'operations',
      phase: 'golden-questions',
      inputs: [DEFAULT_CORPUS],
      outputs: proposalPath ? [outPath, proposalPath] : [outPath],
      verdict: regression ? 'rejected' : 'ok',
      reason: `${passed}/${corpus.questions.length} passed (${Math.round(passRate * 100)}%${trailingMedian !== null ? `, trailing median ${Math.round(trailingMedian * 100)}%` : ''})`,
      evidence_refs: results.filter((r) => !r.pass).map((r) => `fail:${r.id}`),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'golden-questions: event append failed');
  }

  return summary;
}

// ── Helpers ─────────────────────────────────────────────────────────

function readTrailingPassRates(resultsDir, window) {
  if (!existsSync(resultsDir)) return [];
  const files = readdirSync(resultsDir)
    .filter((f) => f.startsWith('results-') && f.endsWith('.json'))
    .map((f) => ({ f, full: join(resultsDir, f), mtime: tryMtime(join(resultsDir, f)) }))
    .filter((e) => e.mtime !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, window);
  const rates = [];
  for (const e of files) {
    try {
      const parsed = JSON.parse(readFileSync(e.full, 'utf8'));
      if (typeof parsed.passRate === 'number') rates.push(parsed.passRate);
    } catch { /* intentional: skip unreadable result files */ }
  }
  return rates;
}

function tryMtime(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function median(nums) {
  if (!nums || nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Scheduler entry ─────────────────────────────────────────────────

export async function checkGoldenQuestions(todayStr, hours, minutes) {
  if (hours !== GOLDEN_HOUR || minutes !== GOLDEN_MINUTE) return;
  if (lastRunDate === todayStr) return;
  lastRunDate = todayStr;
  try {
    const summary = await runGoldenQuestions();
    logger.info({
      passed: summary.passed,
      total: summary.questionCount,
      passRate: summary.passRate,
      regression: summary.regression,
      durationMs: summary.durationMs,
    }, 'golden-questions: nightly run complete');
  } catch (err) {
    logger.error({ err: err.message }, 'golden-questions: scheduled run failed');
  }
}
