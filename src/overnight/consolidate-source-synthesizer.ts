// src/overnight/consolidate-source-synthesizer.ts — synthetic source generator.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.1.
//
// Produces a deterministic conversation-level source (hash + excerpt) for
// candidates EVO returns during shadow mode. This is a Phase-1 compromise:
// the spec's full invariant requires per-line sources, but EVO doesn't
// currently emit them. Synthesized sources let the validator pass on
// well-formed candidates so parity review is possible. At cutover, real
// per-line sources replace these and the synthesizer is deleted or
// downgraded to a fallback.

import { createHash } from 'node:crypto';
import { MAX_EXCERPT_CHARS, type MemorySource } from './consolidate-validate.js';

/** Prefix that distinguishes synthetic sources from real line-level ones. */
export const SYNTHETIC_HASH_PREFIX = 'sha256:conv:';

/**
 * Build a single synthetic source for a whole conversation. Deterministic:
 * same input always produces the same hash and excerpt.
 */
export function synthesizeSources(conversation: string): MemorySource[] {
  const hash = createHash('sha256').update(conversation).digest('hex');
  const excerpt = conversation.slice(0, MAX_EXCERPT_CHARS);
  return [
    {
      hash: `${SYNTHETIC_HASH_PREFIX}${hash}`,
      excerpt,
    },
  ];
}
