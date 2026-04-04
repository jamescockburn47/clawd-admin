// src/tasks/overnight-to-evolution.js — Bridge overnight analysis to evolution tasks
//
// Runs at 5:00 AM. Reads overnight coder results and trace analysis,
// converts high/medium-severity findings into evolution tasks.
// Max 2 tasks per night to avoid flooding the queue.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from '../logger.js';
import { createTask, canRunTask } from '../evolution.js';

const MAX_TASKS_PER_RUN = 2;

let lastRunDate = null;

/**
 * Check if overnight-to-evolution should run (5 AM London time).
 */
async function runOvernightEvolution(sendFn, todayStr) {
  lastRunDate = todayStr;
  try {
    logger.info('overnight-to-evolution: starting');
    const tasks = collectOvernightFindings();

    if (tasks.length === 0) {
      logger.info('overnight-to-evolution: no actionable findings');
      return;
    }

    const created = [];
    for (const finding of tasks.slice(0, MAX_TASKS_PER_RUN)) {
      const rateCheck = canRunTask();
      if (!rateCheck.allowed) {
        logger.info({ reason: rateCheck.reason }, 'overnight-to-evolution: rate limited, stopping');
        break;
      }

      const task = createTask(finding.instruction, 'overnight-analysis', finding.priority);
      if (task) {
        created.push({ id: task.id, title: finding.title });
        logger.info({ taskId: task.id, title: finding.title }, 'overnight-to-evolution: task created');
      }
    }

    if (created.length > 0 && sendFn) {
      const lines = ['*Overnight Analysis → Evolution Tasks*'];
      lines.push(`Created ${created.length} task(s) from overnight findings:\n`);
      for (const t of created) {
        lines.push(`  - ${t.title} (${t.id})`);
      }
      await sendFn(lines.join('\n'));
    }
  } catch (err) {
    logger.error({ err: err.message }, 'overnight-to-evolution: failed');
  }
}

export async function checkOvernightEvolution(sendFn, todayStr, hours) {
  if (lastRunDate === todayStr) return;
  if (hours !== 5) return;
  return runOvernightEvolution(sendFn, todayStr);
}

export async function runOvernightEvolutionNow(sendFn, todayStr) {
  return runOvernightEvolution(sendFn, todayStr);
}

export function getLastOvernightEvoDate() { return lastRunDate; }

/**
 * Collect findings from overnight coder results and trace analysis.
 * Returns array of { title, instruction, priority } sorted by severity.
 */
function collectOvernightFindings() {
  const findings = [];

  // Source 1: Overnight coder code-quality findings
  const qualityFile = join('data', 'overnight-results', 'code-quality.json');
  if (existsSync(qualityFile)) {
    try {
      const quality = JSON.parse(readFileSync(qualityFile, 'utf-8'));
      const issues = quality.issues || quality.findings || quality;
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const severity = issue.severity || issue.level || 'medium';
          if (severity === 'low' || severity === 'info') continue;

          const title = issue.title || issue.summary || issue.description?.slice(0, 60) || 'Code quality fix';
          const files = issue.files || issue.file ? [issue.file] : [];
          const fileList = files.length > 0 ? ` Files: ${files.join(', ')}.` : '';

          findings.push({
            title,
            instruction: `${issue.description || issue.fix || title}${fileList}`,
            priority: severity === 'high' || severity === 'critical' ? 'high' : 'normal',
            score: severity === 'high' || severity === 'critical' ? 3 : 2,
          });
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'overnight-to-evolution: failed to read code-quality.json');
    }
  }

  // Source 2: Trace analysis anomalies
  const traceFile = join('data', 'trace-analysis.json');
  if (existsSync(traceFile)) {
    try {
      const analysis = JSON.parse(readFileSync(traceFile, 'utf-8'));
      const anomalies = analysis.anomalies || [];

      for (const anomaly of anomalies) {
        // Only create tasks for actionable anomalies with suggestions
        if (!anomaly.suggestion && !anomaly.fix) continue;

        findings.push({
          title: anomaly.title || anomaly.type || 'Trace anomaly fix',
          instruction: anomaly.suggestion || anomaly.fix || anomaly.description,
          priority: anomaly.severity === 'high' ? 'high' : 'normal',
          score: anomaly.severity === 'high' ? 3 : 1,
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'overnight-to-evolution: failed to read trace-analysis.json');
    }
  }

  // Source 3: Overnight briefing markdown (parse for actionable items)
  const today = new Date().toISOString().split('T')[0];
  const briefingFile = join('data', 'overnight-results', `briefing-${today}.md`);
  if (existsSync(briefingFile)) {
    try {
      const briefing = readFileSync(briefingFile, 'utf-8');
      // Look for sections with "fix", "improve", "bug", "issue" markers
      const actionLines = briefing.split('\n')
        .filter(line => /^[-*]\s*(fix|improve|bug|issue|refactor|optimise|optimize)/i.test(line.trim()));

      for (const line of actionLines.slice(0, 3)) {
        const clean = line.replace(/^[-*]\s*/, '').trim();
        if (clean.length < 20) continue; // skip too-short items

        findings.push({
          title: clean.slice(0, 60),
          instruction: clean,
          priority: 'normal',
          score: 1,
        });
      }
    } catch {
      // briefing is optional
    }
  }

  // Sort by score descending (highest severity first)
  findings.sort((a, b) => b.score - a.score);

  return findings;
}
