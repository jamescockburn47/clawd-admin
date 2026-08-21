// src/tasks/manual-improvement-run.js — On-demand overnight improvement pipeline
//
// Lets James trigger the full overnight improvement flow manually:
// 1. Forge session
// 2. Bridge overnight findings into evolution tasks
// 3. Execute one pending evolution task
// 4. Generate/send the overnight report

import { runForgeNow, getLatestForgeReport } from './forge-orchestrator.js';
import { runOvernightEvolutionNow } from './overnight-to-evolution.js';
import { checkEvolutionTasks } from './evolution-dispatch.js';
import { sendOvernightReport } from '../overnight-report.js';
import { getEvolutionReport } from '../evolution.js';

function getLondonDateStr(offsetDays = 0) {
  const now = new Date();
  if (offsetDays !== 0) {
    now.setUTCDate(now.getUTCDate() + offsetDays);
  }
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    parts[type] = value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function runImprovementPipelineNow(sendFn = null, opts = {}) {
  const todayStr = opts.todayStr || getLondonDateStr(0);
  const reportDate = opts.reportDate || getLondonDateStr(-1);
  const notify = opts.notify === true;
  const sender = notify && sendFn ? sendFn : async () => {};

  await runForgeNow(sender, todayStr);
  await runOvernightEvolutionNow(sender, todayStr);
  await checkEvolutionTasks(sender);
  await sendOvernightReport(sender, reportDate);

  return {
    todayStr,
    reportDate,
    forge: getLatestForgeReport(),
    evolution: getEvolutionReport(),
  };
}
