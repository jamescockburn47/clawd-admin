// src/overnight/consolidate-promoted-sink.ts — production memory sink.
//
// The non-shadow counterpart to ShadowSink. Writes validated candidates
// straight to EVO memory via the shared memory client. The evidence-chain
// validator in ConsolidateStore already guards this path — any candidate
// that reaches storeValidated() has passed the schema + sources[] check,
// so we can call the store API without further gating.
//
// Activated by CONSOLIDATE_MODE=promoted (the default post-cutover).
// CONSOLIDATE_MODE=shadow falls back to ShadowSink so the old behaviour
// is a flag-flip away if something goes wrong.

import type { StoreClient } from './consolidate-store.js';
import type { MemoryCandidate } from './consolidate-validate.js';

export interface PromotedSinkDeps {
  /**
   * Shape matches memory.js::storeMemory — kept as a dep injection so
   * tests can pass a stub without booting the real memory client.
   */
  storeMemory(
    fact: string,
    category: string,
    tags: string[],
    confidence: number,
    source: string,
  ): Promise<{ stored?: boolean; queued?: boolean; offline?: boolean; error?: string } | void>;
}

export interface PromotedSinkOptions {
  /**
   * Value placed on the stored memory's `source` field. Defaults to
   * "consolidate-promoted" so diagnostics and the morning report can
   * attribute these back to the consolidate stage.
   */
  source?: string;
  /**
   * The chatJid to stamp on stored memories. ConsolidateExtractor does
   * not currently pass the originating conversation JID down to the
   * candidate, so this is set at sink construction from the scheduler-
   * resolved value. When unset, the memory store's default applies.
   */
  chatJid?: string;
  deps: PromotedSinkDeps;
}

export class PromotedSink implements StoreClient {
  constructor(private readonly opts: PromotedSinkOptions) {}

  async storeValidated(candidate: MemoryCandidate): Promise<void> {
    const source = this.opts.source ?? 'consolidate-promoted';
    // Tags: carry the first two source-hashes as evidence-ref markers so
    // downstream tooling (lqc_recent_errors-style audits, memory diagnose)
    // can trace back to the originating conversation line without re-
    // fetching the whole source block.
    const tags: string[] = [];
    for (const s of candidate.sources.slice(0, 2)) {
      if (s?.hash) tags.push(`src:${s.hash.slice(0, 24)}`);
    }
    if (this.opts.chatJid) tags.push(`chat:${this.opts.chatJid}`);

    const result = await this.opts.deps.storeMemory(
      candidate.text,
      candidate.category,
      tags,
      candidate.confidence,
      source,
    );
    // storeMemory returns a status object; a truthy `.error` surfaces.
    // The store wrapper in ConsolidateStore catches thrown errors and
    // counts them — throw here so that behaviour is consistent whether
    // the failure is HTTP-layer (caught inside memory.js) or queued-
    // offline (returned as { queued: true }). Queued is not a failure.
    if (result && typeof result === 'object' && 'error' in result && result.error) {
      throw new Error(String(result.error));
    }
  }
}
