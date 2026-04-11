// src/overnight/report-task.ts — scheduler-invoked REPORT task.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.3.
//
// Runs at 06:50 London, 10 minutes before the morning briefing at 07:00.
// This ordering matters: the briefing reads the generated report file, so
// the report must land first. The task is in-process, reads the event log
// directly, no LLM calls.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OvernightRunner } from './runner.js';
import { makeReportStage, type ReportStageDeps } from './report.js';

export const REPORT_TASK_HOUR = 6;
export const REPORT_TASK_MINUTE = 50;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(DEFAULT_REPO_ROOT, 'data', 'overnight');

let lastReportDate: string | null = null;

/** Test-only guard reset. */
export function resetReportTaskStateForTests(): void {
  lastReportDate = null;
}

export async function checkReport(
  todayStr: string,
  hours: number,
  minutes: number,
  deps?: ReportStageDeps,
): Promise<void> {
  if (hours !== REPORT_TASK_HOUR || minutes !== REPORT_TASK_MINUTE) return;
  if (lastReportDate === todayStr) return;
  lastReportDate = todayStr;

  const resolvedDeps: ReportStageDeps = deps ?? { overnightDir: DEFAULT_OVERNIGHT_DIR };
  const stage = makeReportStage(resolvedDeps);

  const runner = new OvernightRunner({
    mode: 'cheap',
    date: todayStr,
    overnightDir: resolvedDeps.overnightDir,
    repoRoot: DEFAULT_REPO_ROOT,
    skipJanitor: true,
  });
  runner.register('report', stage);
  await runner.run(['report']);
}
