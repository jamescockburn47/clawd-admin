// src/tasks/weekly-retrospective.js — Autonomous weekly self-assessment (Phase 2.2)
// Runs Sunday 4 AM. Reads trace analysis history, identifies top improvement areas,
// posts summary to James via DM, and creates evolution tasks for top 3 issues.
//
// This is Clawd's self-directed improvement loop: traces → patterns → priorities → tasks.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../logger.js';
import { getLatestAnalysis } from './trace-analyser.js';
import { evoFetch, llamaBreaker } from '../evo-client.js';

const RETRO_FILE = join('data', 'weekly-retrospective.json');
const RETRO_LOG = join('data', 'retrospective-log.jsonl');

let lastRetroDate = null;

/**
 * Check if weekly retrospective should run (Sunday 4 AM).
 */
export async function checkWeeklyRetrospective(sendFn, todayStr, hours) {
  if (lastRetroDate === todayStr) return;

  // Only run on Sundays at 4 AM
  const dayOfWeek = new Date(todayStr + 'T12:00:00').getDay();
  if (dayOfWeek !== 0 || hours !== 4) return;

  lastRetroDate = todayStr;

  try {
    logger.info('weekly-retrospective: starting');
    const result = await generateRetrospective(sendFn);

    if (result && sendFn) {
      await sendFn(formatRetroSummary(result));
    }
  } catch (err) {
    logger.error({ err: err.message }, 'weekly-retrospective: failed');
  }
}

export function getLastRetroDate() { return lastRetroDate; }

/**
 * Load trace analysis history (last 4 analyses = ~4 weeks).
 */
function loadAnalysisHistory() {
  const logFile = join('data', 'trace-analysis-log.jsonl');
  if (!existsSync(logFile)) return [];

  try {
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-28) // last 28 daily analyses (~4 weeks)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Load self-improvement history.
 */
function loadImprovementHistory() {
  const logFile = join('data', 'self-improve-log.jsonl');
  if (!existsSync(logFile)) return [];

  try {
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-7) // last 7 cycles
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ask the 30B model to reason about improvement priorities.
 */
async function reasonAboutImprovements(analysisData) {
  const prompt = `You are the self-improvement engine for Clawd, an AI assistant progressing toward AGI.

Analyse these performance metrics from the past week and identify the TOP 3 improvement priorities.

For each priority, specify:
1. What the issue is (with data)
2. Why it matters (impact on user experience)
3. A concrete, scoped code change that would fix it (specific file + function, max 5 files)

TRACE ANALYSIS:
${JSON.stringify(analysisData.latestAnalysis, null, 2)}

ANALYSIS TREND (daily over ${analysisData.history.length} days):
${JSON.stringify(analysisData.history.slice(-7), null, 2)}

SELF-IMPROVEMENT HISTORY:
${JSON.stringify(analysisData.improvementHistory, null, 2)}

IMPROVEMENT AREAS TO CONSIDER:
- Classifier accuracy: are keywords catching enough? Is the 4B accurate on needsPlan?
- Plan quality: decomposition failures, tool resolution errors, synthesis quality
- Routing speed: latency regressions, unnecessary 4B calls
- Quality gate effectiveness: is it catching bad responses?
- Model selection: is MiniMax handling everything it should?
- Tool usage patterns: are tools failing? Are wrong tools being called?

Rules:
- Only suggest improvements that are achievable via the evolution pipeline (code changes, prompt tweaks)
- Each improvement must be scoped to max 5 files, 150 lines changed
- Prefer fixes to the class of bug, not individual instances
- Do not suggest infrastructure changes (model upgrades, hardware) — those are manual decisions

Output JSON only:
{
  "priorities": [
    {
      "rank": 1,
      "title": "short title",
      "issue": "what's wrong, with numbers",
      "impact": "why this matters",
      "fix": "specific code change description",
      "files": ["src/file1.js", "src/file2.js"],
      "severity": "high|medium|low",
      "evolution_instruction": "exact instruction for the evolution pipeline"
    }
  ],
  "overall_health": "good|fair|poor",
  "health_reason": "one sentence"
}`;

  try {
    const result = await llamaBreaker.call(async () => {
      const res = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'You are a performance analysis engine. Output JSON only. Respond in English.' },
            { role: 'user', content: prompt + ' /no_think' },
          ],
          temperature: 0.2,
          max_tokens: 2000,
          cache_prompt: true,
        }),
        timeout: 30_000,
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    }, null);

    if (!result) return null;

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.warn({ err: err.message }, 'weekly-retrospective: LLM reasoning failed');
    return null;
  }
}

/**
 * Generate improvement priorities and optionally create evolution tasks.
 */
async function generateRetrospective(sendFn) {
  const latestAnalysis = getLatestAnalysis();
  const history = loadAnalysisHistory();
  const improvementHistory = loadImprovementHistory();

  if (!latestAnalysis && history.length === 0) {
    logger.info('weekly-retrospective: no trace data yet, skipping');
    return null;
  }

  const analysisData = { latestAnalysis, history, improvementHistory };

  // LLM-powered reasoning about improvements
  const reasoning = await reasonAboutImprovements(analysisData);

  const retro = {
    date: new Date().toISOString(),
    overallHealth: reasoning?.overall_health || 'unknown',
    healthReason: reasoning?.health_reason || 'insufficient data',
    priorities: reasoning?.priorities || [],
    traceSummary: {
      totalTraces: latestAnalysis?.totalTraces || 0,
      planCount: latestAnalysis?.plans?.totalPlans || 0,
      needsPlanF1: latestAnalysis?.needsPlan?.f1 || 0,
      anomalyCount: latestAnalysis?.anomalies?.length || 0,
      routingBreakdown: latestAnalysis?.routing?.percentages || {},
    },
    evolutionTasksCreated: [],
  };

  // Create evolution tasks for top priorities (only high/medium severity)
  if (retro.priorities.length > 0) {
    try {
      const { createTask } = await import('../evolution.js');
      for (const priority of retro.priorities.slice(0, 3)) {
        if (priority.severity === 'low') continue;
        if (!priority.evolution_instruction) continue;

        const task = createTask(
          priority.evolution_instruction,
          'retrospective',
          priority.severity === 'high' ? 'high' : 'normal',
        );

        if (task) {
          retro.evolutionTasksCreated.push({
            taskId: task.id,
            title: priority.title,
            rank: priority.rank,
          });
          logger.info({ taskId: task.id, title: priority.title }, 'weekly-retrospective: evolution task created');
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'weekly-retrospective: evolution task creation failed');
    }
  }

  // Persist
  try {
    writeFileSync(RETRO_FILE, JSON.stringify(retro, null, 2));
    appendFileSync(RETRO_LOG, JSON.stringify({
      date: retro.date,
      health: retro.overallHealth,
      priorityCount: retro.priorities.length,
      tasksCreated: retro.evolutionTasksCreated.length,
    }) + '\n');
  } catch (err) {
    logger.warn({ err: err.message }, 'weekly-retrospective: failed to save');
  }

  return retro;
}

/**
 * Format retrospective for WhatsApp DM.
 */
function formatRetroSummary(retro) {
  const lines = ['*WEEKLY RETROSPECTIVE*'];
  lines.push(`Health: *${retro.overallHealth}* — ${retro.healthReason}`);
  lines.push(`Traces: ${retro.traceSummary.totalTraces} | Plans: ${retro.traceSummary.planCount} | needsPlan F1: ${retro.traceSummary.needsPlanF1}%\n`);

  if (retro.priorities.length > 0) {
    lines.push('*Improvement priorities:*');
    for (const p of retro.priorities) {
      lines.push(`${p.rank}. [${p.severity}] *${p.title}*`);
      lines.push(`   ${p.issue}`);
      lines.push(`   Fix: ${p.fix}`);
      lines.push('');
    }
  } else {
    lines.push('No improvement priorities identified (insufficient data or all metrics healthy).');
  }

  if (retro.evolutionTasksCreated.length > 0) {
    lines.push(`*Evolution tasks queued: ${retro.evolutionTasksCreated.length}*`);
    for (const t of retro.evolutionTasksCreated) {
      lines.push(`  - ${t.title} (${t.taskId})`);
    }
  }

  return lines.join('\n');
}

/**
 * Load the most recent retrospective (for dashboard/report).
 */
export function getLatestRetrospective() {
  try {
    if (!existsSync(RETRO_FILE)) return null;
    return JSON.parse(readFileSync(RETRO_FILE, 'utf-8'));
  } catch {
    return null;
  }
}
