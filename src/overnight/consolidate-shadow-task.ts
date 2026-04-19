// src/overnight/consolidate-shadow-task.ts — scheduler-invoked shadow consolidate task.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.3.
//
// Top-level task function called by src/scheduler.js on its 60-second tick.
// Gates on 02:30 London and a per-day `lastShadowDate` guard so the stage
// runs exactly once per night even if the scheduler tick lands on 02:30
// multiple times (unlikely) or the bot restarts mid-minute.
//
// Dependency injection: the function accepts a `deps` parameter with all
// external clients. In production the factory builds real clients from
// memory.js / topic-index.js. In tests, mocks are passed directly.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';
import { OvernightRunner } from './runner.js';
import { makeConsolidateStage } from './consolidate.js';
import { ShadowSink } from './consolidate-shadow-sink.js';
import { synthesizeSources } from './consolidate-source-synthesizer.js';
import type { ExtractClient } from './consolidate-extract.js';
import type { MaintenanceClient, TopicIndexClient } from './consolidate-maintenance.js';
import type { MemoryCandidate } from './consolidate-validate.js';

/** London hour the task fires. */
export const SHADOW_TASK_HOUR = 2;
/** London minute the task fires (30 min after old 2 AM task). */
export const SHADOW_TASK_MINUTE = 30;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(DEFAULT_REPO_ROOT, 'data', 'overnight');
const DEFAULT_LOG_DIR = join(DEFAULT_REPO_ROOT, 'data', 'conversation-logs');

/** Module-level idempotency guard: one run per YYYY-MM-DD. */
let lastShadowDate: string | null = null;

/**
 * Per-run counter for extract-debug file writes. Caps disk usage on a
 * completely broken extractor that would otherwise produce one debug entry
 * per conversation. Reset at the start of each run in checkConsolidateShadow.
 */
let extractDebugWritesThisRun = 0;
const EXTRACT_DEBUG_MAX_PER_RUN = 5;

/** Reset guard state. Test-only. */
export function resetShadowTaskStateForTests(): void {
  lastShadowDate = null;
  extractDebugWritesThisRun = 0;
}

/**
 * Wrap an ExtractClient so that zero-candidate responses get logged with
 * input/output context and (for the first N per run) persisted to
 * data/overnight/extract-debug-<date>.jsonl for root-cause analysis.
 * Exported for testing. Does not alter the happy path at all — a non-empty
 * candidates array is returned unchanged.
 */
export function withExtractDebug(
  inner: ExtractClient,
  overnightDir: string,
  todayStr: string,
): ExtractClient {
  return {
    extractCandidates: async (conversation, source) => {
      const result = await inner.extractCandidates(conversation, source);
      if (result.candidates.length > 0) return result;

      const conversationLength = conversation.length;
      const sample = conversation.slice(0, 500);

      logger.info(
        {
          source,
          conversation_length: conversationLength,
          sample,
        },
        'consolidate extract returned zero candidates',
      );

      if (extractDebugWritesThisRun < EXTRACT_DEBUG_MAX_PER_RUN) {
        extractDebugWritesThisRun++;
        try {
          await mkdir(overnightDir, { recursive: true });
          const file = join(overnightDir, `extract-debug-${todayStr}.jsonl`);
          const entry = {
            timestamp: new Date().toISOString(),
            source,
            conversation_length: conversationLength,
            sample,
          };
          await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            'failed to write extract-debug entry',
          );
        }
      }

      return result;
    },
  };
}

export interface ShadowTaskDeps {
  overnightDir: string;
  logDir: string;
  repoRoot: string;
  extractClient: ExtractClient;
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
}

/**
 * Wrap any ExtractClient so that every candidate returned gets a synthesized
 * conversation-level source[] attached before reaching the validator. This is
 * the Phase-1 shadow-mode compromise applied uniformly regardless of whether
 * the underlying client is production (extractWithoutStoring) or a test mock.
 */
function withSynthesizedSources(inner: ExtractClient): ExtractClient {
  return {
    extractCandidates: async (conversation, source) => {
      const { candidates } = await inner.extractCandidates(conversation, source);
      return {
        candidates: candidates.map((item) => {
          const base = item as Partial<MemoryCandidate>;
          return {
            ...base,
            sources: synthesizeSources(conversation),
          } as MemoryCandidate;
        }),
      };
    },
  };
}

/**
 * Build a default deps object for production use. Imports memory.js and
 * topic-index.js lazily so tests that inject deps don't pay the cost of
 * loading them (and don't trip config validation on missing env vars).
 */
async function buildDefaultDeps(): Promise<ShadowTaskDeps> {
  const { extractWithoutStoring, triggerMaintenance } = await import('../memory.js');
  const { indexDayTopics, pruneTopicIndex } = await import('../topic-index.js');

  // Raw extract client — just forwards to EVO. Source synthesis is applied
  // uniformly in checkConsolidateShadow via withSynthesizedSources so tests
  // and production go through the same wrapping.
  const extractClient: ExtractClient = {
    extractCandidates: async (conversation, source) => {
      const resp = await extractWithoutStoring(conversation, source);
      const raw = (resp?.extracted ?? []) as unknown[];
      return { candidates: raw };
    },
  };

  const memoryClient: MaintenanceClient = {
    triggerMaintenance: async () => {
      const r = await triggerMaintenance();
      if (!r || r.error) {
        throw new Error(r?.error ?? 'triggerMaintenance returned null');
      }
      return {
        expired: r.expired ?? 0,
        deduplicated: r.deduplicated ?? 0,
        total_after: r.total_after ?? 0,
      };
    },
  };

  const topicClient: TopicIndexClient = {
    indexDayTopics: async (d) => indexDayTopics(d),
    pruneTopicIndex: async (days) => {
      const n = pruneTopicIndex(days);
      return typeof n === 'number' ? n : 0;
    },
  };

  return {
    overnightDir: DEFAULT_OVERNIGHT_DIR,
    logDir: DEFAULT_LOG_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
    extractClient,
    memoryClient,
    topicClient,
  };
}

/** Given today's YYYY-MM-DD, return yesterday's. UTC noon anchor avoids DST drift. */
function yesterdayFor(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Scheduler-invoked shadow consolidate task. Runs once per day at 02:30 London.
 * Writes events to data/overnight/events-<todayStr>.jsonl and validated
 * candidates to data/overnight/shadow-candidates-<todayStr>.jsonl.
 */
export async function checkConsolidateShadow(
  todayStr: string,
  hours: number,
  minutes: number,
  deps?: ShadowTaskDeps,
): Promise<void> {
  if (hours !== SHADOW_TASK_HOUR || minutes !== SHADOW_TASK_MINUTE) return;
  if (lastShadowDate === todayStr) return;
  lastShadowDate = todayStr;
  extractDebugWritesThisRun = 0;

  const resolvedDeps = deps ?? (await buildDefaultDeps());

  const shadowSink = new ShadowSink({
    overnightDir: resolvedDeps.overnightDir,
    todayStr,
  });

  // Wrap extract client with debug layer (outermost) → source synthesis (inner).
  // Debug observes the raw zero-candidate result before synthesis attaches sources,
  // which is the state we actually need to diagnose.
  const debugWrapped = withExtractDebug(
    resolvedDeps.extractClient,
    resolvedDeps.overnightDir,
    todayStr,
  );

  const stage = makeConsolidateStage({
    logDir: resolvedDeps.logDir,
    extractClient: withSynthesizedSources(debugWrapped),
    storeClient: shadowSink,
    memoryClient: resolvedDeps.memoryClient,
    topicClient: resolvedDeps.topicClient,
    yesterdayFor,
  });

  const runner = new OvernightRunner({
    mode: 'cheap',
    date: todayStr,
    overnightDir: resolvedDeps.overnightDir,
    repoRoot: resolvedDeps.repoRoot,
    skipJanitor: true, // in-process: nothing to clean
  });
  runner.register('consolidate', stage);
  await runner.run(['consolidate']);
}
