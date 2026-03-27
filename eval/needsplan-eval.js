// eval/needsplan-eval.js — Labeled dataset for needsPlan classification accuracy
// Run standalone: node eval/needsplan-eval.js
// Import:         import { NEEDS_PLAN_LABELS, NO_PLAN_LABELS, EDGE_CASE_LABELS } from './eval/needsplan-eval.js'
//
// These labeled datasets are used by:
// 1. The self-improvement cycle (src/self-improve/cycle.js) to probe 4B accuracy overnight
// 2. The trace analyser to cross-reference predicted vs actual needsPlan
// 3. This standalone runner to test 4B when EVO is available
//
// With the router rewrite (2026-03-27), all classification goes through the 4B model.
// The old mightNeedPlan() heuristic is removed. These labels remain as ground truth.

// ============================================================================
// LABELED DATASETS
// ============================================================================

// True positives — these SHOULD trigger needsPlan
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

// True negatives — these should NOT trigger needsPlan
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

function calcMetrics(tp, fp, tn, fn) {
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 1;
  const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  const accuracy = (tp + fp + tn + fn) > 0 ? (tp + tn) / (tp + fp + tn + fn) : 1;
  return { precision, recall, f1, accuracy };
}

export function runNeedsPlanEval(classifyFn) {
  const allLabels = [...NEEDS_PLAN_LABELS, ...NO_PLAN_LABELS, ...EDGE_CASE_LABELS];
  const results = { total: 0, correct: 0, tp: 0, fp: 0, tn: 0, fn: 0, failures: [] };

  for (const { msg, expected, reason } of allLabels) {
    results.total++;
    const got = classifyFn(msg);

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

  const metrics = calcMetrics(results.tp, results.fp, results.tn, results.fn);
  return { ...results, ...metrics, timestamp: new Date().toISOString() };
}

// ============================================================================
// STANDALONE RUNNER — requires EVO 4B to be available
// ============================================================================

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && process.argv[1].replace(/\\/g, '/') === __filename.replace(/\\/g, '/')) {
  console.log('\n=== Clawd needsPlan Labeled Dataset ===\n');
  console.log(`True positives: ${NEEDS_PLAN_LABELS.length} cases`);
  console.log(`True negatives: ${NO_PLAN_LABELS.length} cases`);
  console.log(`Edge cases:     ${EDGE_CASE_LABELS.length} cases`);
  console.log(`Total:          ${NEEDS_PLAN_LABELS.length + NO_PLAN_LABELS.length + EDGE_CASE_LABELS.length} labeled cases`);
  console.log('\nThis dataset is used by the self-improvement cycle to probe 4B accuracy overnight.');
  console.log('The old mightNeedPlan() heuristic has been removed — all classification goes through 4B.');
  console.log('\nTo run a live eval against 4B, use the self-improvement cycle or run:');
  console.log('  curl http://10.0.0.2:8085/v1/chat/completions ...');
}
