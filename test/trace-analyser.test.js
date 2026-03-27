// test/trace-analyser.test.js — Trace analyser: routing, categories, models, plans, needsPlan F1, quality gate, timing, anomalies
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { join } from 'path';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const TRACE_FILE = join('data', 'reasoning-traces.jsonl');
let backupExists = false;
const BACKUP_FILE = TRACE_FILE + '.test-backup';

// --- Helpers: synthetic trace builders ---

function makeTrace(overrides = {}) {
  return {
    timestamp: overrides.timestamp || new Date().toISOString(),
    routing: {
      category: 'conversational',
      layer: 'keywords',
      needsPlan: false,
      timeMs: 50,
      ...(overrides.routing || {}),
    },
    model: {
      selected: 'minimax',
      reason: 'default',
      qualityGate: false,
      ...(overrides.model || {}),
    },
    toolsCalled: overrides.toolsCalled || [],
    totalTimeMs: overrides.totalTimeMs || 500,
    plan: overrides.plan !== undefined ? overrides.plan : null,
  };
}

function writeTraces(traces) {
  const lines = traces.map(t => JSON.stringify(t)).join('\n');
  writeFileSync(TRACE_FILE, lines + '\n');
}

function backupTraceFile() {
  if (existsSync(TRACE_FILE)) {
    copyFileSync(TRACE_FILE, BACKUP_FILE);
    backupExists = true;
  }
}

function restoreTraceFile() {
  if (backupExists && existsSync(BACKUP_FILE)) {
    copyFileSync(BACKUP_FILE, TRACE_FILE);
    unlinkSync(BACKUP_FILE);
    backupExists = false;
  } else if (!backupExists && existsSync(TRACE_FILE)) {
    unlinkSync(TRACE_FILE);
  }
}

let analyseTraces;

async function loadModule() {
  const mod = await import('../src/tasks/trace-analyser.js');
  analyseTraces = mod.analyseTraces;
}

// --- Test suites ---

describe('trace-analyser', () => {
  before(async () => {
    backupTraceFile();
    await loadModule();
  });

  after(() => {
    restoreTraceFile();
  });

  // ==================== analyseRouting ====================

  describe('analyseRouting', () => {
    it('10 traces: 5 keyword, 3 4b_classifier, 2 fallback — correct percentages', () => {
      const traces = [
        ...Array(5).fill(null).map(() => makeTrace({ routing: { layer: 'keywords' } })),
        ...Array(3).fill(null).map(() => makeTrace({ routing: { layer: '4b_classifier' } })),
        ...Array(2).fill(null).map(() => makeTrace({ routing: { layer: 'fallback' } })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.routing.counts.keywords, 5);
      assert.equal(result.routing.counts['4b_classifier'], 3);
      assert.equal(result.routing.counts.fallback, 2);
      assert.equal(result.routing.percentages.keywords, 50);
      assert.equal(result.routing.percentages['4b_classifier'], 30);
      assert.equal(result.routing.percentages.fallback, 20);
    });

    it('all keyword — 100% keyword', () => {
      const traces = Array(8).fill(null).map(() => makeTrace({ routing: { layer: 'keywords' } }));
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.routing.percentages.keywords, 100);
      assert.equal(result.routing.percentages.fallback, 0);
      assert.equal(result.routing.percentages['4b_classifier'], 0);
    });

    it('empty traces — all zeros', () => {
      writeTraces([]);
      const result = analyseTraces(365);
      assert.equal(result.totalTraces, 0);
      assert.equal(result.routing.counts.keywords, 0);
      assert.equal(result.routing.counts.fallback, 0);
      assert.equal(result.routing.percentages.keywords, 0);
    });
  });

  // ==================== analyseCategories ====================

  describe('analyseCategories', () => {
    it('mixed categories — sorted by frequency', () => {
      const traces = [
        ...Array(5).fill(null).map(() => makeTrace({ routing: { category: 'calendar' } })),
        ...Array(3).fill(null).map(() => makeTrace({ routing: { category: 'email' } })),
        ...Array(1).fill(null).map(() => makeTrace({ routing: { category: 'legal' } })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const keys = Object.keys(result.categories);
      assert.equal(keys[0], 'calendar');
      assert.equal(keys[1], 'email');
      assert.equal(keys[2], 'legal');
      assert.equal(result.categories.calendar, 5);
      assert.equal(result.categories.email, 3);
      assert.equal(result.categories.legal, 1);
    });

    it('single category — one entry', () => {
      const traces = Array(4).fill(null).map(() => makeTrace({ routing: { category: 'todo' } }));
      writeTraces(traces);
      const result = analyseTraces(365);
      const keys = Object.keys(result.categories);
      assert.equal(keys.length, 1);
      assert.equal(result.categories.todo, 4);
    });
  });

  // ==================== analyseModels ====================

  describe('analyseModels', () => {
    it('mix of minimax and evo models — correct distribution', () => {
      const traces = [
        ...Array(6).fill(null).map(() => makeTrace({ model: { selected: 'minimax', reason: 'default' } })),
        ...Array(3).fill(null).map(() => makeTrace({ model: { selected: 'evo-30b', reason: 'local_routing' } })),
        ...Array(1).fill(null).map(() => makeTrace({ model: { selected: 'claude-opus', reason: 'explicit_request' } })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.models.distribution.minimax, 6);
      assert.equal(result.models.distribution['evo-30b'], 3);
      assert.equal(result.models.distribution['claude-opus'], 1);
    });

    it('model reasons tracked correctly', () => {
      const traces = [
        ...Array(4).fill(null).map(() => makeTrace({ model: { selected: 'minimax', reason: 'default' } })),
        ...Array(2).fill(null).map(() => makeTrace({ model: { selected: 'minimax', reason: 'quality_gate' } })),
        ...Array(1).fill(null).map(() => makeTrace({ model: { selected: 'claude-opus', reason: 'explicit_request' } })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.models.reasons.default, 4);
      assert.equal(result.models.reasons.quality_gate, 2);
      assert.equal(result.models.reasons.explicit_request, 1);
    });
  });

  // ==================== analysePlans ====================

  describe('analysePlans', () => {
    it('traces with plan objects — correct success/failure counts', () => {
      const traces = [
        makeTrace({
          plan: {
            status: 'completed',
            goal: 'check calendar',
            steps: [{ tool: 'calendar_list', status: 'completed' }],
            totalTimeMs: 1000,
          },
        }),
        makeTrace({
          plan: {
            status: 'completed',
            goal: 'send email',
            steps: [{ tool: 'email_send', status: 'completed' }],
            totalTimeMs: 800,
          },
        }),
        makeTrace({
          plan: {
            status: 'failed',
            goal: 'book travel',
            steps: [{ tool: 'travel_search', status: 'failed', error: 'timeout' }],
            totalTimeMs: 5000,
          },
        }),
        makeTrace(), // no plan
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.plans.totalPlans, 3);
      assert.equal(result.plans.statuses.completed, 2);
      assert.equal(result.plans.statuses.failed, 1);
    });

    it('plan with 3 steps, 1 failed — correct avgSteps and failure reasons', () => {
      const traces = [
        makeTrace({
          plan: {
            status: 'partial',
            goal: 'complex task',
            steps: [
              { tool: 'calendar_list', status: 'completed' },
              { tool: 'email_send', status: 'failed', error: 'auth error' },
              { tool: 'todo_add', status: 'completed' },
            ],
            totalTimeMs: 2000,
          },
        }),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.plans.totalPlans, 1);
      assert.equal(result.plans.avgSteps, 3);
      assert.equal(result.plans.failureReasons.length, 1);
      assert.equal(result.plans.failureReasons[0].tool, 'email_send');
      assert.equal(result.plans.failureReasons[0].error, 'auth error');
      assert.equal(result.plans.failureReasons[0].planGoal, 'complex task');
    });

    it('no plans — totalPlans 0', () => {
      const traces = Array(5).fill(null).map(() => makeTrace());
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.plans.totalPlans, 0);
      assert.equal(result.plans.avgSteps, 0);
      assert.equal(result.plans.avgTimeMs, 0);
      assert.deepEqual(result.plans.failureReasons, []);
    });
  });

  // ==================== analyseNeedsPlan (F1 — CRITICAL) ====================

  describe('analyseNeedsPlan', () => {
    it('mixed predictions — precision 71%, recall 63%, F1 67%', () => {
      // 5 TP: predicted needsPlan + used 2+ unique tools
      // 2 FP: predicted needsPlan + used 0-1 tools
      // 3 FN: not predicted + used 2+ unique tools
      const traces = [
        // 5 True Positives: predicted=true, 2+ unique tools
        ...Array(5).fill(null).map(() => makeTrace({
          routing: { needsPlan: true },
          toolsCalled: ['calendar_list', 'email_send'],
        })),
        // 2 False Positives: predicted=true, 0-1 tools
        ...Array(2).fill(null).map(() => makeTrace({
          routing: { needsPlan: true },
          toolsCalled: ['calendar_list'],
        })),
        // 3 False Negatives: predicted=false, 2+ unique tools
        ...Array(3).fill(null).map(() => makeTrace({
          routing: { needsPlan: false },
          toolsCalled: ['calendar_list', 'todo_add'],
        })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const np = result.needsPlan;

      assert.equal(np.predictedTrue, 7);   // 5 TP + 2 FP
      assert.equal(np.predictedFalse, 3);  // 3 FN
      assert.equal(np.actualMultiTool, 8); // 5 TP + 3 FN
      assert.equal(np.truePositives, 5);
      assert.equal(np.falsePositives, 2);
      assert.equal(np.falseNegatives, 3);

      // precision = 5/7 = 0.714... → Math.round(71.4) = 71
      assert.equal(np.precision, 71);
      // recall = 5/8 = 0.625 → Math.round(62.5) = 63
      assert.equal(np.recall, 63);
      // f1 = 2 * (0.714 * 0.625) / (0.714 + 0.625) = 2 * 0.4464 / 1.339 = 0.667 → 67
      assert.equal(np.f1, 67);
    });

    it('all correct predictions — precision 100%, recall 100%, F1 100%', () => {
      const traces = [
        // Predicted true, actually multi-tool (TP)
        ...Array(4).fill(null).map(() => makeTrace({
          routing: { needsPlan: true },
          toolsCalled: ['calendar_list', 'email_send'],
        })),
        // Predicted false, actually single tool (TN)
        ...Array(3).fill(null).map(() => makeTrace({
          routing: { needsPlan: false },
          toolsCalled: ['search'],
        })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const np = result.needsPlan;
      assert.equal(np.precision, 100);
      assert.equal(np.recall, 100);
      assert.equal(np.f1, 100);
      assert.equal(np.truePositives, 4);
      assert.equal(np.falsePositives, 0);
      assert.equal(np.falseNegatives, 0);
    });

    it('all false positives — precision 0%, recall 0%', () => {
      const traces = [
        // Predicted true but no multi-tool (FP)
        ...Array(5).fill(null).map(() => makeTrace({
          routing: { needsPlan: true },
          toolsCalled: [],
        })),
        // Predicted false, no tools (TN)
        ...Array(3).fill(null).map(() => makeTrace({
          routing: { needsPlan: false },
          toolsCalled: [],
        })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const np = result.needsPlan;
      assert.equal(np.precision, 0);
      assert.equal(np.recall, 0);
      assert.equal(np.f1, 0);
      assert.equal(np.truePositives, 0);
      assert.equal(np.falsePositives, 5);
    });

    it('unique tools matter — duplicate tool names count as 1', () => {
      // predicted=true, called same tool twice — should be FP (only 1 unique)
      const traces = [
        makeTrace({
          routing: { needsPlan: true },
          toolsCalled: ['calendar_list', 'calendar_list'],
        }),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.needsPlan.falsePositives, 1);
      assert.equal(result.needsPlan.truePositives, 0);
    });
  });

  // ==================== analyseQualityGate ====================

  describe('analyseQualityGate', () => {
    it('some traces with qualityGate — correct count and percentage', () => {
      const traces = [
        ...Array(3).fill(null).map(() => makeTrace({
          model: { qualityGate: true },
          routing: { category: 'legal' },
        })),
        ...Array(7).fill(null).map(() => makeTrace({
          model: { qualityGate: false },
          routing: { category: 'conversational' },
        })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.qualityGate.totalGated, 3);
      assert.equal(result.qualityGate.percentage, 30);
      assert.equal(result.qualityGate.byCategory.legal, 3);
    });

    it('no quality gate usage — zero count', () => {
      const traces = Array(5).fill(null).map(() => makeTrace({ model: { qualityGate: false } }));
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.qualityGate.totalGated, 0);
      assert.equal(result.qualityGate.percentage, 0);
    });
  });

  // ==================== analyseTiming ====================

  describe('analyseTiming', () => {
    it('known routing times — correct avg and p95', () => {
      // 20 traces with routing times 1..20 ms
      const traces = Array.from({ length: 20 }, (_, i) =>
        makeTrace({ routing: { timeMs: (i + 1) * 10 }, totalTimeMs: (i + 1) * 100 })
      );
      writeTraces(traces);
      const result = analyseTraces(365);

      // avg of 10,20,...,200 = 105
      assert.equal(result.timing.routingAvgMs, 105);

      // p95: sorted = [10,20,...,200], idx = ceil(0.95*20)-1 = 19-1 = 18 → value = 190
      assert.equal(result.timing.routingP95Ms, 190);

      // total avg of 100,200,...,2000 = 1050
      assert.equal(result.timing.totalAvgMs, 1050);

      // total p95: idx = 18 → value = 1900
      assert.equal(result.timing.totalP95Ms, 1900);
    });

    it('empty times — null values', () => {
      // Traces without routing.timeMs
      const traces = [
        makeTrace({ routing: { layer: 'keywords' } }),
      ];
      // Override to remove timeMs
      traces[0].routing.timeMs = undefined;
      traces[0].totalTimeMs = undefined;
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.timing.routingAvgMs, null);
      assert.equal(result.timing.routingP95Ms, null);
      assert.equal(result.timing.totalAvgMs, null);
      assert.equal(result.timing.totalP95Ms, null);
    });
  });

  // ==================== detectAnomalies ====================

  describe('detectAnomalies', () => {
    it('>20% fallback — warning generated', () => {
      // 11 traces, 3 fallback = 27%
      const traces = [
        ...Array(8).fill(null).map(() => makeTrace({ routing: { layer: 'keywords' } })),
        ...Array(3).fill(null).map(() => makeTrace({ routing: { layer: 'fallback' } })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const fallbackAnomaly = result.anomalies.find(a => a.type === 'high_fallback_rate');
      assert.ok(fallbackAnomaly, 'should detect high fallback rate');
      assert.equal(fallbackAnomaly.severity, 'warning');
    });

    it('>50% plan failures — warning generated', () => {
      const traces = [
        makeTrace({ plan: { status: 'failed', steps: [], totalTimeMs: 100 } }),
        makeTrace({ plan: { status: 'failed', steps: [], totalTimeMs: 100 } }),
        makeTrace({ plan: { status: 'completed', steps: [], totalTimeMs: 100 } }),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const planAnomaly = result.anomalies.find(a => a.type === 'high_plan_failure_rate');
      assert.ok(planAnomaly, 'should detect high plan failure rate');
      assert.equal(planAnomaly.severity, 'warning');
      assert.ok(planAnomaly.detail.includes('2/3'));
    });

    it('3+ needsPlan false positives — info generated', () => {
      const traces = [
        // 3 FP: predicted needsPlan but used 0-1 tools
        ...Array(3).fill(null).map(() => makeTrace({
          routing: { needsPlan: true },
          toolsCalled: ['single_tool'],
        })),
        // Some normal traces
        ...Array(5).fill(null).map(() => makeTrace({
          routing: { needsPlan: false },
          toolsCalled: [],
        })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const npAnomaly = result.anomalies.find(a => a.type === 'needsplan_false_positives');
      assert.ok(npAnomaly, 'should detect needsPlan false positives');
      assert.equal(npAnomaly.severity, 'info');
      assert.ok(npAnomaly.detail.includes('3'));
    });

    it('p95 routing >5000ms — warning generated', () => {
      // Need >10 traces. Most fast, a few very slow.
      const traces = [
        ...Array(10).fill(null).map(() => makeTrace({ routing: { timeMs: 100 } })),
        makeTrace({ routing: { timeMs: 6000 } }),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const slowAnomaly = result.anomalies.find(a => a.type === 'slow_routing');
      assert.ok(slowAnomaly, 'should detect slow routing');
      assert.equal(slowAnomaly.severity, 'warning');
    });

    it('category >60% of messages (>20 traces) — info generated', () => {
      // 25 traces, 18 conversational = 72%
      const traces = [
        ...Array(18).fill(null).map(() => makeTrace({ routing: { category: 'conversational' } })),
        ...Array(7).fill(null).map(() => makeTrace({ routing: { category: 'calendar' } })),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      const catAnomaly = result.anomalies.find(a => a.type === 'category_imbalance');
      assert.ok(catAnomaly, 'should detect category imbalance');
      assert.equal(catAnomaly.severity, 'info');
      assert.ok(catAnomaly.detail.includes('conversational'));
    });

    it('no anomalies for healthy data', () => {
      // 25 traces, balanced routing, no plans failing, no FP, fast routing, balanced categories
      const categories = ['calendar', 'email', 'todo', 'conversational', 'legal'];
      const layers = ['keywords', '4b_classifier', 'keywords', 'keywords', '4b_classifier'];
      const traces = Array.from({ length: 25 }, (_, i) =>
        makeTrace({
          routing: {
            layer: layers[i % layers.length],
            category: categories[i % categories.length],
            needsPlan: false,
            timeMs: 50 + (i * 10),
          },
          totalTimeMs: 300 + (i * 20),
        })
      );
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.anomalies.length, 0, `unexpected anomalies: ${JSON.stringify(result.anomalies)}`);
    });
  });

  // ==================== Edge cases ====================

  describe('edge cases', () => {
    it('old traces outside maxAgeDays are excluded', () => {
      const oldDate = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
      const recentDate = new Date().toISOString();
      const traces = [
        makeTrace({ timestamp: oldDate, routing: { category: 'old_one' } }),
        makeTrace({ timestamp: recentDate, routing: { category: 'recent_one' } }),
      ];
      writeTraces(traces);
      const result = analyseTraces(3); // only last 3 days
      assert.equal(result.totalTraces, 1);
      assert.equal(result.categories.recent_one, 1);
      assert.equal(result.categories.old_one, undefined);
    });

    it('malformed JSONL lines are skipped', () => {
      const good = JSON.stringify(makeTrace({ routing: { category: 'valid' } }));
      writeFileSync(TRACE_FILE, `${good}\n{INVALID JSON\n${good}\n`);
      const result = analyseTraces(365);
      assert.equal(result.totalTraces, 2);
    });

    it('missing trace file — returns zero traces', () => {
      if (existsSync(TRACE_FILE)) unlinkSync(TRACE_FILE);
      const result = analyseTraces(365);
      assert.equal(result.totalTraces, 0);
    });

    it('plan with replanCount tracked in adaptationRate', () => {
      const traces = [
        makeTrace({
          plan: { status: 'completed', steps: [], totalTimeMs: 500, replanCount: 2 },
        }),
        makeTrace({
          plan: { status: 'completed', steps: [], totalTimeMs: 300, replanCount: 0 },
        }),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.plans.adaptationRate, 1); // only 1 plan had replanCount > 0
    });

    it('plan toolUsage counts across all plan steps', () => {
      const traces = [
        makeTrace({
          plan: {
            status: 'completed',
            goal: 'multi-tool task',
            steps: [
              { tool: 'calendar_list', status: 'completed' },
              { tool: 'email_send', status: 'completed' },
              { tool: 'calendar_list', status: 'completed' },
            ],
            totalTimeMs: 1500,
          },
        }),
      ];
      writeTraces(traces);
      const result = analyseTraces(365);
      assert.equal(result.plans.toolUsage.calendar_list, 2);
      assert.equal(result.plans.toolUsage.email_send, 1);
    });
  });
});
