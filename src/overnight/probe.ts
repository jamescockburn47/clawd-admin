// src/overnight/probe.ts — PROBE stage composer.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2.
//
// Orchestrates the four observation sub-tasks (quality enrichment, pattern
// extraction, candidate proposal, drift check), writes events to the
// overnight event log, and appends observations to the weekly observation
// log. Runs once per night at 03:15 London via checkProbe in the scheduler.
//
// Order matters: quality → patterns → candidates → drift.
//   - quality is free (no LLM), produces the base set of failures
//   - patterns uses the trace analysis + failures to propose observations
//   - candidates uses patterns + failures to propose concrete improvements
//   - drift is an independent check that samples historical exchanges
//
// On Monday, the stage rolls over last week's observation file to the
// archive dir before writing any new observations.

import type { StageContext, StageFn } from './runner.js';
import {
  appendObservation,
  isoWeekOf,
  rolloverIfMonday,
} from './probe-observations.js';
import { enrichQualityFailures, type TraceAnalysisClient } from './probe-quality.js';
import { extractPatterns, type EvoChatClient, type TraceSource } from './probe-patterns.js';
import { proposeCandidates } from './probe-candidates.js';
import {
  sampleHistoricalExchanges,
  runDriftChecks,
  type ReplayClient,
  type GraderClient,
} from './probe-drift.js';

export interface ProbeStageDeps {
  overnightDir: string;
  logDir: string;
  traceAnalysisClient: TraceAnalysisClient;
  evoChatClient: EvoChatClient;
  replayClient: ReplayClient;
  graderClient: GraderClient;
  driftWindowDays: number;
  driftSampleSize: number;
}

/**
 * Build a probe stage function from injected clients. Returned function
 * is ready for OvernightRunner.register('probe', ...).
 */
export function makeProbeStage(deps: ProbeStageDeps): StageFn {
  return async function runProbeStage(ctx: StageContext): Promise<void> {
    const now = new Date(ctx.date + 'T12:00:00Z');
    const isoWeek = isoWeekOf(now);

    // Monday rollover (no-op on other days, harmless)
    try {
      const rolled = await rolloverIfMonday(now, { overnightDir: deps.overnightDir });
      if (rolled.archivedWeek) {
        await ctx.appendEvent({
          stage: 'probe',
          phase: 'rollover',
          inputs: [`observations-${rolled.archivedWeek}.jsonl`],
          outputs: [`archive/observations-${rolled.archivedWeek}.jsonl`],
          verdict: 'ok',
          reason: `archived ${rolled.archivedWeek}`,
          evidence_refs: [],
          rollback_ref: null,
          budget: { opus_sessions: 0, tokens: 0 },
        });
      }
    } catch (err) {
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'rollover',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `rollover failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    }

    // --- 1. Quality-gate enrichment (free, no LLM) ----------------------
    let qualityObservations: Awaited<ReturnType<typeof enrichQualityFailures>> = [];
    try {
      qualityObservations = await enrichQualityFailures({
        client: deps.traceAnalysisClient,
        date: ctx.date,
      });
      for (const obs of qualityObservations) {
        await appendObservation(obs, { isoWeek, overnightDir: deps.overnightDir });
      }
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'quality',
        inputs: ['data/trace-analysis.json'],
        outputs: [`observations-${isoWeek}.jsonl:${qualityObservations.length}`],
        verdict: 'ok',
        reason: `${qualityObservations.length} quality_failure observations from trace analysis`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'quality',
        inputs: ['data/trace-analysis.json'],
        outputs: [],
        verdict: 'failed',
        reason: `quality enrichment failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    }

    // --- 2. Pattern observations (EVO 30B) ------------------------------
    let patternObservations: Awaited<ReturnType<typeof extractPatterns>> = [];
    try {
      const traceAnalysis = await deps.traceAnalysisClient.readAnalysis();
      const traceSources: TraceSource = {
        traceAnalysis,
        recentTraceSamples: [], // Could be populated from a trace-sampling helper later
      };
      patternObservations = await extractPatterns({
        client: deps.evoChatClient,
        sources: traceSources,
        date: ctx.date,
      });
      for (const obs of patternObservations) {
        await appendObservation(obs, { isoWeek, overnightDir: deps.overnightDir });
      }
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'patterns',
        inputs: ['data/trace-analysis.json'],
        outputs: [`observations-${isoWeek}.jsonl:${patternObservations.length}`],
        verdict: 'ok',
        reason: `${patternObservations.length} pattern observations from EVO 30B`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'patterns',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `pattern extraction failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    }

    // --- 3. Candidate proposals (EVO 30B) -------------------------------
    let candidateObservations: Awaited<ReturnType<typeof proposeCandidates>> = [];
    try {
      candidateObservations = await proposeCandidates({
        client: deps.evoChatClient,
        sources: {
          patterns: patternObservations,
          qualityFailures: qualityObservations,
        },
        date: ctx.date,
      });
      for (const obs of candidateObservations) {
        await appendObservation(obs, { isoWeek, overnightDir: deps.overnightDir });
      }
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'candidates',
        inputs: [`patterns:${patternObservations.length}`, `failures:${qualityObservations.length}`],
        outputs: [`observations-${isoWeek}.jsonl:${candidateObservations.length}`],
        verdict: 'ok',
        reason: `${candidateObservations.length} candidate proposals from EVO 30B`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'candidates',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `candidate proposal failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    }

    // --- 4. Drift checks ------------------------------------------------
    try {
      const exchanges = await sampleHistoricalExchanges({
        logDir: deps.logDir,
        referenceDate: ctx.date,
        windowDays: deps.driftWindowDays,
        sampleSize: deps.driftSampleSize,
      });
      const driftObservations = await runDriftChecks({
        exchanges,
        replay: deps.replayClient,
        grader: deps.graderClient,
        date: ctx.date,
      });
      for (const obs of driftObservations) {
        await appendObservation(obs, { isoWeek, overnightDir: deps.overnightDir });
      }
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'drift',
        inputs: [`conversation-logs:${exchanges.length}`],
        outputs: [`observations-${isoWeek}.jsonl:${driftObservations.length}`],
        verdict: 'ok',
        reason: `${exchanges.length} exchanges replayed, ${driftObservations.length} non-neutral drift observations`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    } catch (err) {
      await ctx.appendEvent({
        stage: 'probe',
        phase: 'drift',
        inputs: [],
        outputs: [],
        verdict: 'failed',
        reason: `drift check failed: ${(err as Error).message}`,
        evidence_refs: [],
        rollback_ref: null,
        budget: { opus_sessions: 0, tokens: 0 },
      });
    }
  };
}
