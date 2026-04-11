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
import { loadParticipationLearningSummary, type ParticipationLearningSummary } from './participation-summary.js';
import { renderReportAsText } from './morning-report-text.js';

export type { ParticipationLearningSummary } from './participation-summary.js';
export { renderReportAsText, MAX_REPORT_WORDS } from './morning-report-text.js';

export type ReportMode = 'cheap' | 'deep' | 'emergency';

export interface BuildReportOptions {
  date: string;
  events: OvernightEvent[];
  observations: Observation[];
  now: Date;
  /** When set, skips loading from data/runtime/participation-decisions.jsonl. */
  participationSummary?: ParticipationLearningSummary | null;
  /** Repo root for loading participation decision JSONL (optional). */
  repoRoot?: string;
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
  /** Aggregates from participation decision log when available; null if no data. */
  participationSummary: ParticipationLearningSummary | null;
}

export type MorningReportWithText = MorningReport & { text: string };

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

function resolveParticipationSummary(opts: BuildReportOptions): ParticipationLearningSummary | null {
  if (opts.participationSummary !== undefined) {
    return opts.participationSummary;
  }
  if (opts.repoRoot) {
    return loadParticipationLearningSummary(opts.date, opts.repoRoot);
  }
  return null;
}

/**
 * Build a structured morning report from the night's events and this week's
 * observations. Pure except optional read of participation JSONL when repoRoot is set.
 * Returns rendered `text` for WhatsApp (same output as renderReportAsText on the report body).
 */
export function buildMorningReport(opts: BuildReportOptions): MorningReportWithText {
  const classification = classifyObservations(opts.observations, { now: opts.now });
  const errors = opts.events.filter((e) => e.verdict === 'failed' || e.verdict === 'rejected');
  const summary = buildSummary(opts.events, classification);
  const budget = buildBudget(opts.events);
  const mode = detectMode(opts.events);
  const participationSummary = resolveParticipationSummary(opts);

  const report: MorningReport = {
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
    participationSummary,
  };
  const text = renderReportAsText(report);
  return { ...report, text };
}
