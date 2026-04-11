// src/overnight/probe-quality.ts — quality-gate failure enrichment for PROBE.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2 item 4.
//
// Reads the trace analyser's latest output (data/trace-analysis.json),
// converts each detected anomaly into a quality_failure observation, and
// returns them for the probe stage to persist to the weekly log.
//
// Why anomalies specifically: the spec refers to "the existing quality-gate
// rejection log" but no such file exists on disk — the trace analyser is the
// closest proxy. It already detects behavioural and performance issues (slow
// cortex, low tool usage, plan failures, quality-gate hit rates) and produces
// a structured list. Each anomaly carries evidence (detail + suggestion), so
// it maps cleanly to the QualityFailureObservation schema.

import type { QualityFailureObservation } from './probe-observations.js';

/** Minimal shape we need from trace-analysis.json. */
interface TraceAnalysisShape {
  anomalies?: Array<{
    type?: string;
    severity?: string;
    detail?: string;
    suggestion?: string;
  }>;
  agency?: {
    totalDecisions?: number;
    sent?: number;
    silent?: number;
    sentRate?: number;
    approvalRate?: number | null;
    feedback?: {
      positive?: number;
      negative?: number;
      neutral?: number;
      corrections?: number;
    };
  };
  qualityGate?: {
    totalGated?: number;
    byCategory?: Record<string, number>;
  };
  [key: string]: unknown;
}

export interface TraceAnalysisClient {
  /** Read and return the latest trace analysis JSON, or null if unavailable. */
  readAnalysis(): Promise<TraceAnalysisShape | null>;
}

export interface EnrichOptions {
  client: TraceAnalysisClient;
  date: string; // YYYY-MM-DD for the observation date field
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 5,
  error: 4,
  warning: 3,
  info: 2,
  debug: 1,
};

/**
 * Convert trace-analysis anomalies into quality_failure observations.
 * One observation per anomaly. Category is taken from qualityGate.byCategory
 * (most-gated category) if the anomaly detail mentions it; otherwise falls
 * back to the anomaly type.
 */
export async function enrichQualityFailures(
  opts: EnrichOptions,
): Promise<QualityFailureObservation[]> {
  const analysis = await opts.client.readAnalysis();
  if (!analysis) return [];

  const anomalies = analysis.anomalies;
  const agency = analysis.agency;
  if ((!Array.isArray(anomalies) || anomalies.length === 0) && !(agency && typeof agency === 'object' && (agency.totalDecisions ?? 0) > 0)) {
    return [];
  }

  const gatedCategories = analysis.qualityGate?.byCategory ?? {};
  const gatedCategoryKeys = Object.keys(gatedCategories);

  const observations: QualityFailureObservation[] = [];

  for (const anomaly of Array.isArray(anomalies) ? anomalies : []) {
    const type = anomaly.type ?? 'unknown';
    const severity = (anomaly.severity ?? 'info').toLowerCase();
    const detail = anomaly.detail ?? '';
    const suggestion = anomaly.suggestion ?? '';

    // Try to find a category from qualityGate.byCategory whose name appears
    // in the anomaly detail. Falls back to the anomaly type.
    const matchedCategory = gatedCategoryKeys.find((c) =>
      detail.toLowerCase().includes(c.toLowerCase()),
    );
    const category = matchedCategory ?? type;

    const weight = SEVERITY_WEIGHT[severity] ?? 2;

    observations.push({
      kind: 'quality_failure',
      date: opts.date,
      category,
      rejection_reason: detail ? `${type}: ${detail}` : type,
      cortex_summary: suggestion || undefined,
      evidence_refs: [`trace-analysis:${type}`],
      weight,
    });
  }

  if (agency && typeof agency === 'object' && (agency.totalDecisions ?? 0) > 0) {
    const positive = agency.feedback?.positive ?? 0;
    const negative = agency.feedback?.negative ?? 0;
    const corrections = agency.feedback?.corrections ?? 0;
    const approvalRate = agency.approvalRate;

    observations.push({
      kind: 'quality_failure',
      date: opts.date,
      category: 'ambient_agency',
      rejection_reason:
        `ambient agency summary: sent=${agency.sent ?? 0}, silent=${agency.silent ?? 0}, ` +
        `approvalRate=${approvalRate ?? 'n/a'}, positive=${positive}, negative=${negative}, corrections=${corrections}`,
      cortex_summary:
        negative > positive || corrections > 0
          ? 'Ambient participation is drawing mixed or negative feedback — tighten intervention thresholds and prefer only high-confidence contributions.'
          : 'Monitor ambient participation quality and keep intervention thresholds calibrated against real reactions.',
      evidence_refs: ['trace-analysis:ambient_agency'],
      weight:
        approvalRate !== null && approvalRate !== undefined && approvalRate < 60
          ? 4
          : negative > 0 || corrections > 0
            ? 3
            : 2,
    });
  }

  return observations;
}
