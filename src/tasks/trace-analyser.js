// src/tasks/trace-analyser.js — Overnight reasoning trace analysis (Phase 2.1)
// Reads data/reasoning-traces.jsonl, identifies patterns in:
//   - Classifier accuracy by category (keyword vs 4B vs fallback)
//   - Plan success/failure rates and failure modes
//   - Model selection patterns and quality gate usage
//   - needsPlan detection accuracy (predicted vs actual tool count)
// Outputs summary to data/trace-analysis.json for overnight report + dashboard.
// Runs at 3 AM, after dream mode (22:05) and self-improvement (1 AM).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import logger from '../logger.js';

const TRACE_FILE = join('data', 'reasoning-traces.jsonl');
const ANALYSIS_FILE = join('data', 'trace-analysis.json');
const ANALYSIS_LOG = join('data', 'trace-analysis-log.jsonl');

let lastAnalysisDate = null;

/**
 * Check if trace analysis should run (3 AM daily).
 */
export async function checkTraceAnalysis(sendFn, todayStr, hours) {
  if (lastAnalysisDate === todayStr) return;
  if (hours !== 3) return;

  lastAnalysisDate = todayStr;

  try {
    logger.info('trace-analyser: starting overnight analysis');
    const result = analyseTraces(7); // last 7 days
    saveAnalysis(result);

    if (sendFn && result.totalTraces > 0) {
      await sendFn(formatAnalysisSummary(result));
    }
  } catch (err) {
    logger.error({ err: err.message }, 'trace-analyser: overnight analysis failed');
  }
}

export function getLastAnalysisDate() { return lastAnalysisDate; }

/**
 * Read and parse traces from the JSONL file.
 * @param {number} maxAgeDays - Only include traces from the last N days
 * @returns {object[]} Parsed trace entries
 */
function readTraces(maxAgeDays = 7) {
  if (!existsSync(TRACE_FILE)) return [];
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const traces = [];

  try {
    const lines = readFileSync(TRACE_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.timestamp).getTime() >= cutoff) {
          traces.push(entry);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'trace-analyser: failed to read traces');
  }

  return traces;
}

/**
 * Main analysis function. Produces a comprehensive summary.
 */
export function analyseTraces(maxAgeDays = 7) {
  const traces = readTraces(maxAgeDays);

  const result = {
    analysedAt: new Date().toISOString(),
    periodDays: maxAgeDays,
    totalTraces: traces.length,

    // Routing layer breakdown
    routing: analyseRouting(traces),

    // Category distribution
    categories: analyseCategories(traces),

    // Model selection patterns
    models: analyseModels(traces),

    // Plan execution analysis
    plans: analysePlans(traces),

    // needsPlan accuracy (predicted vs actual)
    needsPlan: analyseNeedsPlan(traces),

    // Quality gate usage
    qualityGate: analyseQualityGate(traces),

    // Timing analysis
    timing: analyseTiming(traces),

    // Anomalies and potential issues
    anomalies: detectAnomalies(traces),
  };

  return result;
}

// --- Routing layer analysis ---

function analyseRouting(traces) {
  const layers = { keywords: 0, '4b_classifier': 0, llm_classifier: 0, complexity: 0, fallback: 0, image: 0 };

  for (const t of traces) {
    const layer = t.routing?.layer || 'unknown';
    if (layer in layers) layers[layer]++;
    else layers[layer] = (layers[layer] || 0) + 1;
  }

  const total = traces.length || 1;
  return {
    counts: layers,
    percentages: Object.fromEntries(
      Object.entries(layers).map(([k, v]) => [k, Math.round((v / total) * 100)])
    ),
  };
}

// --- Category distribution ---

function analyseCategories(traces) {
  const cats = {};
  for (const t of traces) {
    const cat = t.routing?.category || 'unknown';
    cats[cat] = (cats[cat] || 0) + 1;
  }

  // Sort by frequency
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(sorted);
}

// --- Model selection ---

function analyseModels(traces) {
  const models = {};
  const reasons = {};

  for (const t of traces) {
    const model = t.model?.selected || 'unknown';
    const reason = t.model?.reason || 'unknown';
    models[model] = (models[model] || 0) + 1;
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  return { distribution: models, reasons };
}

// --- Plan analysis ---

function analysePlans(traces) {
  const planTraces = traces.filter(t => t.plan);

  if (planTraces.length === 0) {
    return { totalPlans: 0, statuses: {}, avgSteps: 0, failureReasons: [], avgTimeMs: 0 };
  }

  const statuses = {};
  let totalSteps = 0;
  let totalTimeMs = 0;
  const failureReasons = [];
  const toolUsage = {};

  for (const t of planTraces) {
    const plan = t.plan;
    const status = plan.status || 'unknown';
    statuses[status] = (statuses[status] || 0) + 1;

    if (plan.steps) {
      totalSteps += plan.steps.length;
      for (const step of plan.steps) {
        const tool = step.tool || 'unknown';
        toolUsage[tool] = (toolUsage[tool] || 0) + 1;

        if (step.status === 'failed') {
          failureReasons.push({
            tool: step.tool,
            error: (step.error || '').slice(0, 100),
            planGoal: (plan.goal || '').slice(0, 80),
          });
        }
      }
    }

    if (plan.totalTimeMs) totalTimeMs += plan.totalTimeMs;
  }

  return {
    totalPlans: planTraces.length,
    statuses,
    avgSteps: Math.round(totalSteps / planTraces.length * 10) / 10,
    avgTimeMs: Math.round(totalTimeMs / planTraces.length),
    failureReasons: failureReasons.slice(0, 10), // top 10
    toolUsage,
    adaptationRate: planTraces.filter(t => t.plan.replanCount > 0).length,
  };
}

// --- needsPlan accuracy estimation ---

function analyseNeedsPlan(traces) {
  // Compare: traces where needsPlan was predicted vs actual tool usage
  let predictedTrue = 0;
  let predictedFalse = 0;
  let actualMultiTool = 0;  // used 2+ distinct tools
  let truePositives = 0;    // predicted plan, actually used multi-tool
  let falsePositives = 0;   // predicted plan, used 0-1 tools
  let falseNegatives = 0;   // didn't predict plan, but used 2+ tools

  for (const t of traces) {
    const predicted = !!t.routing?.needsPlan;
    const toolCount = (t.toolsCalled || []).length;
    const uniqueTools = new Set(t.toolsCalled || []).size;
    const actualNeedsMulti = uniqueTools >= 2;

    if (predicted) predictedTrue++;
    else predictedFalse++;

    if (actualNeedsMulti) actualMultiTool++;

    if (predicted && actualNeedsMulti) truePositives++;
    if (predicted && !actualNeedsMulti) falsePositives++;
    if (!predicted && actualNeedsMulti) falseNegatives++;
  }

  const precision = predictedTrue > 0 ? truePositives / predictedTrue : 0;
  const recall = actualMultiTool > 0 ? truePositives / actualMultiTool : 0;
  const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  return {
    predictedTrue,
    predictedFalse,
    actualMultiTool,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: Math.round(precision * 100),
    recall: Math.round(recall * 100),
    f1: Math.round(f1 * 100),
  };
}

// --- Quality gate analysis ---

function analyseQualityGate(traces) {
  const gated = traces.filter(t => t.model?.qualityGate);
  const byCategory = {};

  for (const t of gated) {
    const cat = t.routing?.category || 'unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  return {
    totalGated: gated.length,
    percentage: traces.length > 0 ? Math.round((gated.length / traces.length) * 100) : 0,
    byCategory,
  };
}

// --- Timing analysis ---

function analyseTiming(traces) {
  const routingTimes = traces.map(t => t.routing?.timeMs).filter(t => typeof t === 'number');
  const totalTimes = traces.map(t => t.totalTimeMs).filter(t => typeof t === 'number');

  return {
    routingAvgMs: routingTimes.length > 0 ? Math.round(avg(routingTimes)) : null,
    routingP95Ms: routingTimes.length > 0 ? Math.round(percentile(routingTimes, 95)) : null,
    totalAvgMs: totalTimes.length > 0 ? Math.round(avg(totalTimes)) : null,
    totalP95Ms: totalTimes.length > 0 ? Math.round(percentile(totalTimes, 95)) : null,
  };
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Anomaly detection ---

function detectAnomalies(traces) {
  const anomalies = [];

  // High fallback rate
  const fallbackCount = traces.filter(t => t.routing?.layer === 'fallback').length;
  if (traces.length > 10 && fallbackCount / traces.length > 0.2) {
    anomalies.push({
      type: 'high_fallback_rate',
      severity: 'warning',
      detail: `${Math.round((fallbackCount / traces.length) * 100)}% of messages falling back to default routing`,
      suggestion: 'Review keyword rules coverage — too many messages bypassing classification',
    });
  }

  // Plan failure rate
  const planTraces = traces.filter(t => t.plan);
  const failedPlans = planTraces.filter(t => t.plan.status === 'failed');
  if (planTraces.length >= 3 && failedPlans.length / planTraces.length > 0.5) {
    anomalies.push({
      type: 'high_plan_failure_rate',
      severity: 'warning',
      detail: `${failedPlans.length}/${planTraces.length} plans failed`,
      suggestion: 'Check decomposition quality — model may be producing invalid plans',
    });
  }

  // needsPlan false positive rate
  const fpTraces = traces.filter(t => t.routing?.needsPlan && (t.toolsCalled || []).length <= 1);
  if (fpTraces.length >= 3) {
    anomalies.push({
      type: 'needsplan_false_positives',
      severity: 'info',
      detail: `${fpTraces.length} messages predicted needsPlan but used 0-1 tools`,
      suggestion: 'Refine 4B classifier prompt to reduce over-prediction',
    });
  }

  // Slow routing (p95 > 5s)
  const routingTimes = traces.map(t => t.routing?.timeMs).filter(t => typeof t === 'number');
  if (routingTimes.length > 10) {
    const p95 = percentile(routingTimes, 95);
    if (p95 > 5000) {
      anomalies.push({
        type: 'slow_routing',
        severity: 'warning',
        detail: `Routing p95 is ${p95}ms (threshold: 5000ms)`,
        suggestion: 'Check 4B classifier latency — may need to adjust timeout or fall back to keywords',
      });
    }
  }

  // Category imbalance — one category dominating
  const cats = {};
  for (const t of traces) {
    const cat = t.routing?.category || 'unknown';
    cats[cat] = (cats[cat] || 0) + 1;
  }
  const maxCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  if (maxCat && traces.length > 20 && maxCat[1] / traces.length > 0.6) {
    anomalies.push({
      type: 'category_imbalance',
      severity: 'info',
      detail: `"${maxCat[0]}" is ${Math.round((maxCat[1] / traces.length) * 100)}% of all messages`,
      suggestion: 'May indicate routing bias or actual usage pattern — review if unexpected',
    });
  }

  return anomalies;
}

// --- Persistence ---

function saveAnalysis(result) {
  try {
    writeFileSync(ANALYSIS_FILE, JSON.stringify(result, null, 2));
    appendFileSync(ANALYSIS_LOG, JSON.stringify({
      timestamp: result.analysedAt,
      totalTraces: result.totalTraces,
      anomalyCount: result.anomalies.length,
      planCount: result.plans.totalPlans,
      needsPlanF1: result.needsPlan.f1,
    }) + '\n');
    logger.info({ traces: result.totalTraces, anomalies: result.anomalies.length }, 'trace-analyser: analysis saved');
  } catch (err) {
    logger.warn({ err: err.message }, 'trace-analyser: failed to save analysis');
  }
}

/**
 * Load the most recent analysis (for dashboard / overnight report).
 */
export function getLatestAnalysis() {
  try {
    if (!existsSync(ANALYSIS_FILE)) return null;
    return JSON.parse(readFileSync(ANALYSIS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Format analysis into a WhatsApp-friendly summary.
 */
function formatAnalysisSummary(result) {
  const lines = ['*TRACE ANALYSIS*'];
  lines.push(`Period: ${result.periodDays}d | ${result.totalTraces} traces\n`);

  // Routing
  const r = result.routing.percentages;
  lines.push(`*Routing:* keywords ${r.keywords || 0}%, 4B ${r['4b_classifier'] || 0}%, fallback ${r.fallback || 0}%`);

  // Top categories
  const topCats = Object.entries(result.categories).slice(0, 4);
  lines.push(`*Categories:* ${topCats.map(([k, v]) => `${k} (${v})`).join(', ')}`);

  // Models
  const m = result.models.distribution;
  lines.push(`*Models:* ${Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // Plans
  if (result.plans.totalPlans > 0) {
    const p = result.plans;
    lines.push(`*Plans:* ${p.totalPlans} total | avg ${p.avgSteps} steps | ${p.avgTimeMs}ms avg`);
    lines.push(`  Statuses: ${Object.entries(p.statuses).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  }

  // needsPlan
  const np = result.needsPlan;
  if (np.predictedTrue + np.predictedFalse > 0) {
    lines.push(`*needsPlan:* precision ${np.precision}%, recall ${np.recall}%, F1 ${np.f1}%`);
  }

  // Quality gate
  if (result.qualityGate.totalGated > 0) {
    lines.push(`*Quality gate:* ${result.qualityGate.totalGated} reviews (${result.qualityGate.percentage}%)`);
  }

  // Timing
  const t = result.timing;
  if (t.routingAvgMs) {
    lines.push(`*Timing:* routing avg ${t.routingAvgMs}ms p95 ${t.routingP95Ms}ms | total avg ${t.totalAvgMs}ms p95 ${t.totalP95Ms}ms`);
  }

  // Anomalies
  if (result.anomalies.length > 0) {
    lines.push('');
    for (const a of result.anomalies) {
      lines.push(`[${a.severity}] ${a.detail}`);
    }
  }

  return lines.join('\n');
}
