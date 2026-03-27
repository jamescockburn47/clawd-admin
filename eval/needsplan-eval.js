// eval/needsplan-eval.js — Offline eval for mightNeedPlan() heuristic
// Run standalone: node eval/needsplan-eval.js
// Import:         import { runNeedsPlanEval, NEEDS_PLAN_LABELS, NO_PLAN_LABELS, EDGE_CASE_LABELS } from './eval/needsplan-eval.js'
//
// Tests the lightweight heuristic that gates whether the 4B classifier is called.
// Runs OFFLINE — no EVO, no model inference. Pure regex/heuristic evaluation.

// Must set before any imports (config.js hard-exits without this)
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'eval-placeholder';

// Dynamic import to ensure env is set first
const router = await import('../src/router.js');
const { mightNeedPlan } = router;

// ============================================================================
// LABELED DATASETS
// ============================================================================

// True positives — these SHOULD trigger mightNeedPlan
export const NEEDS_PLAN_LABELS = [
  { msg: 'what do I need to do this week and are there any calendar conflicts', expected: true, reason: 'multi-source overview' },
  { msg: 'search my emails for the Anderson matter and draft a summary', expected: true, reason: 'search + action' },
  { msg: 'check if I\'m free Thursday and if so book the 0930 train', expected: true, reason: 'conditional + booking' },
  { msg: 'find Henry\'s school events, check train times, and add them to my calendar', expected: true, reason: '3-step chain' },
  { msg: 'review my todos, check what\'s overdue, and email me a summary', expected: true, reason: 'multi-tool synthesis' },
  { msg: 'prepare me for the disclosure deadline', expected: true, reason: 'implicit multi-step' },
  { msg: 'what happened this week and what\'s coming up next week', expected: true, reason: 'temporal multi-search' },
  { msg: 'search for emails from Anderson, read the latest one, and draft a reply', expected: true, reason: 'sequential chain' },
  { msg: 'check my calendar for next week and cross-reference with my todo list', expected: true, reason: 'cross-reference' },
  { msg: 'find trains to York on Friday, check my calendar is free, and book the cheapest', expected: true, reason: 'plan + book' },
  { msg: 'compare my schedule this week with last week', expected: true, reason: 'temporal comparison' },
  { msg: 'get the weather forecast and suggest what to pack for York', expected: true, reason: 'multi-source reasoning' },
];

// True negatives — these should NOT trigger mightNeedPlan
export const NO_PLAN_LABELS = [
  { msg: 'what\'s on my calendar today', expected: false, reason: 'single tool' },
  { msg: 'add milk to the shopping list', expected: false, reason: 'single action' },
  { msg: 'what\'s the weather in London', expected: false, reason: 'single lookup' },
  { msg: 'check my email', expected: false, reason: 'single tool' },
  { msg: 'hello how are you', expected: false, reason: 'conversational' },
  { msg: 'what time is it', expected: false, reason: 'trivial' },
  { msg: 'trains to York tomorrow', expected: false, reason: 'single lookup' },
  { msg: 'remind me to call the dentist', expected: false, reason: 'single add' },
  { msg: 'who won the football last night', expected: false, reason: 'single search' },
  { msg: 'read my latest email', expected: false, reason: 'single tool' },
  { msg: 'what\'s 2 + 2', expected: false, reason: 'trivial' },
  { msg: 'system status', expected: false, reason: 'single tool' },
];

// Edge cases with annotated expected results
export const EDGE_CASE_LABELS = [
  { msg: 'check my email and let me know if anything urgent', expected: true, reason: 'search + filter + judge' },
  { msg: 'what trains are there and how much do they cost', expected: false, reason: 'single API returns both' },
  { msg: 'book a train', expected: false, reason: 'single action' },
  { msg: 'cancel my 3pm meeting and move it to Thursday', expected: true, reason: 'find + delete + create' },
  { msg: 'summarise my day', expected: true, reason: 'calendar + todos + emails' },
];

// ============================================================================
// EVAL FUNCTIONS
// ============================================================================

function runLabelSet(labels) {
  const results = { total: 0, correct: 0, tp: 0, fp: 0, tn: 0, fn: 0, failures: [] };

  for (const { msg, expected, reason } of labels) {
    results.total++;
    const got = mightNeedPlan(msg);

    if (got === expected) {
      results.correct++;
      if (got) results.tp++;
      else results.tn++;
    } else {
      if (got) results.fp++;
      else results.fn++;
      results.failures.push({ msg, expected, got, reason });
    }
  }

  return results;
}

function calcMetrics(tp, fp, tn, fn) {
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 1;
  const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + fp + tn + fn) > 0 ? (tp + tn) / (tp + fp + tn + fn) : 1;
  return { precision, recall, f1, accuracy };
}

export function runNeedsPlanEval() {
  const positives = runLabelSet(NEEDS_PLAN_LABELS);
  const negatives = runLabelSet(NO_PLAN_LABELS);
  const edges = runLabelSet(EDGE_CASE_LABELS);

  // Aggregate across all sets
  const totalTP = positives.tp + negatives.tp + edges.tp;
  const totalFP = positives.fp + negatives.fp + edges.fp;
  const totalTN = positives.tn + negatives.tn + edges.tn;
  const totalFN = positives.fn + negatives.fn + edges.fn;
  const totalCorrect = positives.correct + negatives.correct + edges.correct;
  const totalTests = positives.total + negatives.total + edges.total;

  const overall = calcMetrics(totalTP, totalFP, totalTN, totalFN);
  const allFailures = [...positives.failures, ...negatives.failures, ...edges.failures];

  return {
    timestamp: new Date().toISOString(),
    positives: {
      total: positives.total,
      correct: positives.correct,
      accuracy: positives.total > 0 ? positives.correct / positives.total : 1,
      failures: positives.failures,
    },
    negatives: {
      total: negatives.total,
      correct: negatives.correct,
      accuracy: negatives.total > 0 ? negatives.correct / negatives.total : 1,
      failures: negatives.failures,
    },
    edges: {
      total: edges.total,
      correct: edges.correct,
      accuracy: edges.total > 0 ? edges.correct / edges.total : 1,
      failures: edges.failures,
    },
    precision: overall.precision,
    recall: overall.recall,
    f1: overall.f1,
    overall: overall.accuracy,
    totalTests,
    totalCorrect,
    allFailures,
  };
}

// ============================================================================
// STANDALONE RUNNER
// ============================================================================

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && process.argv[1].replace(/\\/g, '/') === __filename.replace(/\\/g, '/')) {
  const results = runNeedsPlanEval();

  console.log('\n=== Clawd needsPlan Heuristic Eval ===\n');

  const sections = [
    ['True positives (should need plan)', results.positives],
    ['True negatives (should NOT need plan)', results.negatives],
    ['Edge cases', results.edges],
  ];

  for (const [name, section] of sections) {
    const pct = (section.accuracy * 100).toFixed(1);
    const status = section.accuracy === 1 ? 'PASS' : 'FAIL';
    console.log(`${status}  ${name}: ${pct}% (${section.correct}/${section.total})`);
    for (const f of section.failures) {
      console.log(`  >>> MISS  "${f.msg}"`);
      console.log(`           expected=${f.expected}  got=${f.got}  (${f.reason})`);
    }
  }

  console.log(`\n--- Aggregate Metrics ---`);
  console.log(`Accuracy:  ${(results.overall * 100).toFixed(1)}% (${results.totalCorrect}/${results.totalTests})`);
  console.log(`Precision: ${(results.precision * 100).toFixed(1)}%`);
  console.log(`Recall:    ${(results.recall * 100).toFixed(1)}%`);
  console.log(`F1:        ${(results.f1 * 100).toFixed(1)}%`);

  if (results.allFailures.length > 0) {
    console.log(`\n${results.allFailures.length} failure(s) detected.`);
  } else {
    console.log('\nAll evals passed.');
  }

  process.exit(results.overall < 1.0 ? 1 : 0);
}
