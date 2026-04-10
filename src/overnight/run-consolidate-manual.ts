// src/overnight/run-consolidate-manual.ts — manual invoker for the CONSOLIDATE stage.
//
// Runs the new consolidate stage against yesterday's logs using real EVO clients.
// Intended for shadow-mode testing alongside the existing 2 AM improvement-cycle.js
// task during the 3-night soak period. NOT wired into the scheduler.
//
// Usage:
//   npx tsx src/overnight/run-consolidate-manual.ts [YYYY-MM-DD]
//
// If no date is provided, uses today (London-local) — which means "yesterday" from
// consolidate's perspective is the day whose logs are read.

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromConversation, storeMemory, triggerMaintenance } from '../memory.js';
import { indexDayTopics, pruneTopicIndex } from '../topic-index.js';
import logger from '../logger.js';
import { OvernightRunner } from './runner.js';
import { makeConsolidateStage } from './consolidate.js';
import type { MemoryCandidate } from './consolidate-validate.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');

function todayLondon(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')!.value;
  const month = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

function yesterdayFor(date: string): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const date = process.argv[2] ?? todayLondon();
  const overnightDir = join(REPO_ROOT, 'data', 'overnight');
  const logDir = join(REPO_ROOT, 'data', 'conversation-logs');

  logger.info({ date, overnightDir, logDir }, 'manual consolidate: starting');

  const stage = makeConsolidateStage({
    logDir,
    extractClient: {
      extractCandidates: async (conversation, source) => {
        // Existing extractFromConversation auto-stores with store_results:true.
        // The new contract requires store_results:false so Node can validate.
        // For the shadow run we accept the auto-store as a harmless dup (the
        // store client below is a no-op) and just harvest the candidate list
        // from the response. A follow-up task will change the EVO /extract
        // caller to use store_results:false explicitly; see README of phase 1.
        const resp = await extractFromConversation(conversation, source);
        const raw = (resp?.extracted ?? []) as unknown[];
        return {
          candidates: raw.map((item) => {
            // EVO does not currently emit sources[]. This is expected for
            // shadow mode — such candidates will land in the rejected log
            // and be visible in the morning. When EVO is updated to emit
            // sources[], they will flow through as valid.
            const candidate = item as MemoryCandidate;
            return candidate;
          }),
        };
      },
    },
    storeClient: {
      // No-op for shadow mode. The existing extractFromConversation path
      // already stored the entries when called above (store_results:true).
      // When we cut over in the follow-up task, this becomes a real call
      // to storeMemory() with the validated candidate payload.
      storeValidated: async (_candidate) => { /* intentional: shadow mode no-op */ },
    },
    memoryClient: {
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
    },
    topicClient: {
      indexDayTopics: async (d) => indexDayTopics(d),
      pruneTopicIndex: async (days) => {
        const n = pruneTopicIndex(days);
        return typeof n === 'number' ? n : 0;
      },
    },
    yesterdayFor,
  });

  const runner = new OvernightRunner({
    mode: 'cheap',
    date,
    overnightDir,
    repoRoot: REPO_ROOT,
    skipJanitor: true, // manual run — nothing to clean up
  });
  runner.register('consolidate', stage);
  await runner.run(['consolidate']);

  // Unused import guard — storeMemory is referenced here so the follow-up
  // task can simply uncomment the production call path without re-adding
  // the import.
  void storeMemory;

  logger.info({ date }, 'manual consolidate: complete');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err: err.message }, 'manual consolidate failed');
  process.exit(1);
});
