// src/tools/overnight-status.ts — Query last night's overnight job outcomes
//
// Unlike overnight_report (which regenerates + sends the full HTML/WhatsApp report),
// this tool reads the already-persisted artifacts and returns a concise plain-text
// summary Clint can explain in conversation.
//
// Reads from:
// - data/forge/reports/YYYY-MM-DD.json       (forge session outcome)
// - data/evolution-tasks.json                (task queue state — today's tasks)
// - data/self-improve/cycle-YYYY-MM-DD.json  (self-improve cycle, if exists)

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';
import { loadTasks } from '../evolution.js';

interface StatusInput {
  date?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, '..', '..');

/** Return a concise plain-text summary of what ran overnight. */
export async function overnightStatus({ date }: StatusInput = {}): Promise<string> {
  const dateStr = date || yesterdayLondon();
  const parts: string[] = [];

  parts.push(`*Overnight jobs for ${dateStr}:*`);
  parts.push('');

  // --- Forge ---
  const forgePath = join(REPO_DIR, 'data', 'forge', 'reports', `${dateStr}.json`);
  if (existsSync(forgePath)) {
    try {
      const f = JSON.parse(readFileSync(forgePath, 'utf-8'));
      parts.push(formatForgeSummary(f));
    } catch (err: any) {
      parts.push(`*Forge:* report file exists but failed to parse — ${err.message}`);
    }
  } else {
    parts.push(`*Forge:* no report for ${dateStr} (did not run or report missing).`);
  }
  parts.push('');

  // --- Evolution tasks created today ---
  try {
    const tasks = loadTasks();
    const todays = tasks.filter((t: any) => t.created?.startsWith(dateStr));
    if (todays.length === 0) {
      parts.push(`*Evolution queue:* no tasks created on ${dateStr}.`);
    } else {
      parts.push(`*Evolution queue (${todays.length} task${todays.length === 1 ? '' : 's'}):*`);
      for (const t of todays) {
        const shortInstr = (t.instruction || '').slice(0, 80);
        parts.push(`  - [${t.status}] ${t.id} (${t.source}) — ${shortInstr}`);
      }
    }
  } catch (err: any) {
    parts.push(`*Evolution queue:* failed to read — ${err.message}`);
  }
  parts.push('');

  // --- Self-improve cycle ---
  const selfImprovePath = join(REPO_DIR, 'data', 'self-improve', `cycle-${dateStr}.json`);
  if (existsSync(selfImprovePath)) {
    try {
      const si = JSON.parse(readFileSync(selfImprovePath, 'utf-8'));
      const applied = si.appliedRules ?? si.applied ?? 0;
      const rejected = si.rejectedRules ?? si.rejected ?? 0;
      const iters = si.iterations ?? '?';
      parts.push(`*Self-improvement:* ${iters} iterations, ${applied} rules applied, ${rejected} rejected.`);
    } catch {
      // intentional: self-improve log is optional
    }
  }

  // --- Overnight report file ---
  const reportPath = join(REPO_DIR, '..', 'clawdbot-logs', `overnight-report-${dateStr}.json`);
  if (existsSync(reportPath)) {
    parts.push(`*Dream report:* generated (overnight-report-${dateStr}.json).`);
  }

  logger.info({ date: dateStr }, 'overnight_status tool invoked');
  return parts.join('\n').trim();
}

function formatForgeSummary(f: any): string {
  const lines: string[] = [];
  lines.push(`*Forge:* ${describeOutcome(f)}`);

  if (f.spec) lines.push(`  Spec: ${f.spec}`);
  if (f.nightlyTouchAction && f.nightlyTouchFiles?.length) {
    lines.push(`  Nightly touch: ${f.nightlyTouchAction} → ${f.nightlyTouchFiles.join(', ')}`);
  }
  if (f.deployAction) lines.push(`  Deploy action: ${f.deployAction}`);
  if (f.tasks?.length) lines.push(`  Queued task(s): ${f.tasks.join(', ')}`);

  // Phase errors
  if (f.phases) {
    const failed = Object.entries(f.phases)
      .filter(([, p]: any) => p.status === 'error' || p.error)
      .map(([n, p]: any) => `${n}: ${p.error || 'error'}`);
    if (failed.length > 0) {
      lines.push(`  Phase errors: ${failed.join('; ')}`);
    }
  }

  return lines.join('\n');
}

function describeOutcome(f: any): string {
  const { phases = {}, deployAction, spec } = f;
  const failedPhases = Object.entries(phases).filter(([, p]: any) => p.status === 'error').map(([n]) => n);

  if (failedPhases.includes('analysis') || failedPhases.includes('architect')) {
    return `failed early (${failedPhases.join(', ')}) — nothing implemented.`;
  }
  if (deployAction === 'auto-deployed') {
    return `auto-deployed: "${spec || 'overnight improvement'}".`;
  }
  if (deployAction === 'queued') {
    return `built and waiting for approval: "${spec || 'overnight improvement'}".`;
  }
  if (deployAction === 'deploy-failed') {
    return `built but deploy failed — reverted automatically.`;
  }
  if (phases.nightlyTouch?.status === 'ok' && !phases.implement) {
    return `nightly touch only, no major spec this session.`;
  }
  return `session complete, no notable output.`;
}

function yesterdayLondon(): string {
  // Match Europe/London for day boundary — forge runs late night / early morning local time
  const now = new Date();
  const london = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  // If it's before 07:00 local, "yesterday" is still the previous calendar day
  // but the forge report for the just-completed session is today's date stamp (04:00 London)
  // so default to today when after 00:00 and before next forge start
  if (london.getHours() < 7) {
    return london.toISOString().split('T')[0];
  }
  const yesterday = new Date(london.getTime() - 86400000);
  return yesterday.toISOString().split('T')[0];
}
