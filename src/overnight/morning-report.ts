// src/overnight/morning-report.ts — structured morning report generator.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.3.
//
// Pure module. Takes the night's events + the week's observations and
// produces a structured MorningReport object with six sections:
// overnight summary, NEW this week, CONTINUING, DRIFT alerts, DEFERRED,
// ARCHIVE. Also exports a plain-text renderer for WhatsApp delivery.
//
// The report is DETERMINISTIC: given the same input, it produces the
// same output. No LLM calls. No staleness re-computation beyond what
// report-grooming already did. No fabrication.

import type { OvernightEvent } from './events.js';
import type {
  Observation,
  CandidateObservation,
  DriftObservation,
} from './probe-observations.js';
import {
  classifyObservations,
  type ClassifiedObservations,
} from './report-grooming.js';

/** Hard cap on rendered word count for WhatsApp delivery. */
export const MAX_REPORT_WORDS = 600;

export type ReportMode = 'cheap' | 'deep' | 'emergency';

export interface BuildReportOptions {
  date: string;
  events: OvernightEvent[];
  observations: Observation[];
  now: Date;
}

export interface ReportSummary {
  consolidateEvents: number;
  probeEvents: number;
  operationsEvents: number;
  reportEvents: number;
  improveEvents: number;
  memoryStored: number;
  memoryRejected: number;
  patternsObserved: number;
  candidatesProposed: number;
  driftAlertsThisWeek: number;
  qualityFailuresThisWeek: number;
  backupOk: boolean;
  traceAnalysisOk: boolean;
}

export interface ReportBudget {
  opus_sessions_used: number;
  tokens_used: number;
}

export interface MorningReport {
  date: string;
  mode: ReportMode;
  events: OvernightEvent[];
  errors: OvernightEvent[];
  summary: ReportSummary;
  newThisWeek: Observation[];
  continuingWithFreshEvidence: Observation[];
  driftAlerts: DriftObservation[];
  deferredCandidates: CandidateObservation[];
  archive: Observation[];
  classification: ClassifiedObservations;
  budget: ReportBudget;
}

function detectMode(events: OvernightEvent[]): ReportMode {
  const hasImprove = events.some((e) => e.stage === 'improve');
  if (!hasImprove) return 'cheap';
  // Emergency mode: improve ran outside the normal Saturday window. Cheap
  // heuristic: if any improve event reason mentions "emergency" or "on-demand".
  for (const e of events) {
    if (e.stage === 'improve' && /emergency|on[- ]?demand/i.test(e.reason)) {
      return 'emergency';
    }
  }
  return 'deep';
}

function extractCount(reason: string, key: string): number {
  const m = reason.match(new RegExp(`${key}=(\\d+)`));
  return m ? parseInt(m[1]!, 10) : 0;
}

function buildSummary(
  events: OvernightEvent[],
  classification: ClassifiedObservations,
): ReportSummary {
  const summary: ReportSummary = {
    consolidateEvents: 0,
    probeEvents: 0,
    operationsEvents: 0,
    reportEvents: 0,
    improveEvents: 0,
    memoryStored: 0,
    memoryRejected: 0,
    patternsObserved: classification.patternsCurrentWeek,
    candidatesProposed: classification.candidatesCurrentWeek,
    driftAlertsThisWeek: classification.driftAlerts.length,
    qualityFailuresThisWeek: classification.qualityFailuresCurrentWeek,
    backupOk: false,
    traceAnalysisOk: false,
  };

  for (const e of events) {
    switch (e.stage) {
      case 'consolidate': {
        summary.consolidateEvents += 1;
        if (e.phase === 'store' && e.verdict === 'ok') {
          summary.memoryStored += extractCount(e.reason, 'stored');
          summary.memoryRejected += extractCount(e.reason, 'rejected');
        }
        break;
      }
      case 'probe':
        summary.probeEvents += 1;
        break;
      case 'operations': {
        summary.operationsEvents += 1;
        if (e.phase === 'daily-backup' && e.verdict === 'ok') summary.backupOk = true;
        if (e.phase === 'trace-analyser' && e.verdict === 'ok') summary.traceAnalysisOk = true;
        break;
      }
      case 'report':
        summary.reportEvents += 1;
        break;
      case 'improve':
        summary.improveEvents += 1;
        break;
    }
  }

  return summary;
}

function buildBudget(events: OvernightEvent[]): ReportBudget {
  let opus = 0;
  let tokens = 0;
  for (const e of events) {
    opus += e.budget?.opus_sessions ?? 0;
    tokens += e.budget?.tokens ?? 0;
  }
  return { opus_sessions_used: opus, tokens_used: tokens };
}

/**
 * Build a structured morning report from the night's events and this week's
 * observations. Pure: no I/O.
 */
export function buildMorningReport(opts: BuildReportOptions): MorningReport {
  const classification = classifyObservations(opts.observations, { now: opts.now });
  const errors = opts.events.filter((e) => e.verdict === 'failed' || e.verdict === 'rejected');
  const summary = buildSummary(opts.events, classification);
  const budget = buildBudget(opts.events);
  const mode = detectMode(opts.events);

  return {
    date: opts.date,
    mode,
    events: opts.events,
    errors,
    summary,
    newThisWeek: classification.newThisWeek,
    continuingWithFreshEvidence: classification.continuingWithFreshEvidence,
    driftAlerts: classification.driftAlerts,
    deferredCandidates: classification.deferredCandidates,
    archive: classification.archive,
    classification,
    budget,
  };
}

// --- Plain text rendering ----------------------------------------------

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/London',
  });
}

function renderErrors(report: MorningReport): string | null {
  if (report.errors.length === 0) return null;
  const lines = [`Errors (${report.errors.length}):`];
  for (const e of report.errors) {
    lines.push(`  ${e.stage}/${e.phase}: ${e.reason}`);
  }
  return lines.join('\n');
}

function renderMemorySection(report: MorningReport): string {
  const { memoryStored, memoryRejected } = report.summary;
  const lines = ['Memory:'];
  if (report.summary.consolidateEvents === 0) {
    lines.push('  not run last night (consolidate stage produced no events).');
    return lines.join('\n');
  }
  lines.push(
    `  Extracted ${memoryStored} candidate memories from yesterday's conversations.`,
  );
  if (memoryRejected > 0) {
    lines.push(
      `  ${memoryRejected} rejected with no supporting evidence.`,
    );
  }
  lines.push(
    '  Saved to the shadow file for review, not yet promoted to EVO memory.',
  );
  return lines.join('\n');
}

const KNOWN_OPS_PHASES = new Set([
  'daily-backup',
  'trace-analyser',
  'system-refresh',
  'ground-truth',
]);

function renderOperationsSection(report: MorningReport): string {
  const lines: string[] = [];
  const opsEvents = report.events.filter((e) => e.stage === 'operations' && e.verdict !== 'failed');

  const byPhase = new Map<string, OvernightEvent>();
  for (const e of opsEvents) {
    if (!byPhase.has(e.phase)) byPhase.set(e.phase, e);
  }

  const backup = byPhase.get('daily-backup');
  if (backup) {
    lines.push(`Backup:\n  ${backup.reason}. If EVO crashed tonight, nothing since the backup would be lost.`);
  }
  const trace = byPhase.get('trace-analyser');
  if (trace) {
    lines.push(`Traces:\n  ${trace.reason}. These feed the weekly improve cycle.`);
  }
  const sys = byPhase.get('system-refresh');
  if (sys) {
    lines.push(`System knowledge:\n  ${sys.reason}.`);
  }
  const gt = byPhase.get('ground-truth');
  if (gt) {
    lines.push(`Ground truth:\n  ${gt.reason}. (Only updates when a response is flagged as gold.)`);
  }

  // Render any unknown ops phases with a generic fallback so new tasks
  // become visible the moment they start writing events, without needing
  // bespoke render copy.
  for (const [phase, event] of byPhase) {
    if (KNOWN_OPS_PHASES.has(phase)) continue;
    lines.push(`${phase}:\n  ${event.reason}`);
  }

  return lines.join('\n\n');
}

function renderProbeSection(report: MorningReport): string | null {
  if (report.summary.probeEvents === 0) return null;
  const s = report.summary;
  const parts: string[] = [];
  if (s.patternsObserved > 0) parts.push(`${s.patternsObserved} patterns observed`);
  if (s.candidatesProposed > 0) parts.push(`${s.candidatesProposed} candidates proposed`);
  if (s.driftAlertsThisWeek > 0) parts.push(`${s.driftAlertsThisWeek} drift alerts`);
  if (s.qualityFailuresThisWeek > 0) parts.push(`${s.qualityFailuresThisWeek} quality failures`);
  if (parts.length === 0) parts.push('no new observations');
  return `Probe:\n  ${parts.join(', ')}.`;
}

function renderDriftSection(report: MorningReport): string | null {
  if (report.driftAlerts.length === 0) return null;
  const lines = [`DRIFT alerts (${report.driftAlerts.length}):`];
  for (const d of report.driftAlerts.slice(0, 3)) {
    lines.push(`  [${d.input_hash}] ${d.reason}`);
  }
  if (report.driftAlerts.length > 3) {
    lines.push(`  ... and ${report.driftAlerts.length - 3} more`);
  }
  return lines.join('\n');
}

function renderNewThisWeek(report: MorningReport): string | null {
  if (report.newThisWeek.length === 0) return null;
  const patterns = report.newThisWeek.filter((o) => o.kind === 'pattern');
  const failures = report.newThisWeek.filter((o) => o.kind === 'quality_failure');
  if (patterns.length === 0 && failures.length === 0) return null;

  const lines = ['NEW this week:'];
  for (const p of patterns.slice(0, 3)) {
    if (p.kind === 'pattern') {
      lines.push(`  - ${p.observation} (weight ${p.weight})`);
    }
  }
  for (const f of failures.slice(0, 3)) {
    if (f.kind === 'quality_failure') {
      lines.push(`  - [${f.category}] ${f.rejection_reason}`);
    }
  }
  return lines.join('\n');
}

function renderDeferredCandidates(report: MorningReport): string | null {
  if (report.deferredCandidates.length === 0) return null;
  const lines = [`DEFERRED to next deep run (${report.deferredCandidates.length}):`];
  for (const c of report.deferredCandidates.slice(0, 5)) {
    lines.push(`  - [w=${c.weight}] ${c.title}`);
    lines.push(`      ${c.scope}`);
  }
  return lines.join('\n');
}

function renderArchive(report: MorningReport): string | null {
  if (report.archive.length === 0) return null;
  return `ARCHIVE: ${report.archive.length} items from prior weeks, collapsed.`;
}

function renderBudget(report: MorningReport): string {
  const { opus_sessions_used, tokens_used } = report.budget;
  return `Budget: ${opus_sessions_used} Opus, ${tokens_used.toLocaleString('en-GB')} tokens.`;
}

/**
 * Render a structured report to plain text suitable for WhatsApp. Word-capped
 * at MAX_REPORT_WORDS with an omission pointer to the console for details.
 */
export function renderReportAsText(report: MorningReport): string {
  const sections: string[] = [`*Overnight — ${formatDate(report.date)}* (${report.mode})`];

  const errors = renderErrors(report);
  if (errors) sections.push(errors);

  sections.push(renderMemorySection(report));

  const ops = renderOperationsSection(report);
  if (ops) sections.push(ops);

  const probe = renderProbeSection(report);
  if (probe) sections.push(probe);

  const drift = renderDriftSection(report);
  if (drift) sections.push(drift);

  const newThis = renderNewThisWeek(report);
  if (newThis) sections.push(newThis);

  const deferred = renderDeferredCandidates(report);
  if (deferred) sections.push(deferred);

  const archive = renderArchive(report);
  if (archive) sections.push(archive);

  sections.push(renderBudget(report));
  if (report.errors.length === 0) {
    sections.push('No errors.');
  }

  const full = sections.join('\n\n');
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_REPORT_WORDS) return full;

  const truncated = words.slice(0, MAX_REPORT_WORDS).join(' ');
  return `${truncated}\n\n... (further events omitted, open Clint Console for full detail)`;
}
