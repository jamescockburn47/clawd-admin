// src/overnight/overnight-digest.ts — plain-English formatter for overnight events.
// Spec: docs/superpowers/specs/2026-04-10-overnight-digest-and-console-design.md §4.3.
//
// Pure function. Takes an event list (as returned by queryEvents), returns a
// ~140-word plain-English block suitable for a WhatsApp DM. Errors surface at
// the top; each stage gets a human-readable paragraph; missing stages say
// "not run last night"; unknown phases fall through to a generic renderer.

import type { OvernightEvent } from './events.js';

/** Hard cap on rendered word count. Excess content is truncated. */
export const DIGEST_WORD_CAP = 400;

/**
 * Per-phase copy generators. Each takes the event(s) for that phase and
 * returns a single plain-English sentence. Unknown phases fall through to
 * a generic "phase: reason" line so new events are always visible even
 * before dedicated copy is written.
 */
type PhaseRenderer = (events: OvernightEvent[]) => string;

const CONSOLIDATE_PHASE_COPY: Record<string, PhaseRenderer> = {
  extract: (events) => {
    const e = events[0]!;
    const match = e.reason.match(/candidates=(\d+)/);
    const count = match ? match[1] : '?';
    return `Extracted ${count} candidate memories from yesterday's conversations.`;
  },
  store: (events) => {
    const e = events[0]!;
    const stored = e.reason.match(/stored=(\d+)/)?.[1] ?? '?';
    const rejected = e.reason.match(/rejected=(\d+)/)?.[1] ?? '?';
    return `They are in the shadow file for review, not yet in EVO's real memory. Once cutover is approved, ${stored} will be searchable during chats (${rejected} rejected with no evidence).`;
  },
  maintenance: (events) => {
    const e = events[0]!;
    const expired = e.reason.match(/expired=(\d+)/)?.[1];
    const topics = e.reason.match(/topics_indexed=(\d+)/)?.[1];
    if (expired && topics) {
      return `Cleaned up ${expired} stale memories and indexed ${topics} topics for yesterday.`;
    }
    return `Memory cleanup complete.`;
  },
};

const OPERATIONS_PHASE_COPY: Record<string, PhaseRenderer> = {
  'daily-backup': (events) => {
    const e = events[0]!;
    return `Full bot state saved. ${e.reason}. If EVO crashed tonight, nothing since the backup would be lost.`;
  },
  'trace-analyser': (events) => {
    const e = events[0]!;
    return `${e.reason}. These accumulate as evidence for the weekly improve cycle.`;
  },
  'system-refresh': (events) => {
    const e = events[0]!;
    return `Reseeded knowledge files into EVO memory. ${e.reason}. The bot's awareness of its own code paths and config is current.`;
  },
  'ground-truth': (events) => {
    const e = events[0]!;
    return `${e.reason}. (Ground truth only updates when you flag a response as gold.)`;
  },
};

const SECTION_HEADINGS: Record<string, string> = {
  consolidate: 'Memory',
  operations_backup: 'Backup',
  operations_traces: 'Traces',
  operations_system: 'System knowledge',
  operations_ground: 'Ground truth',
};

/**
 * Format an overnight digest from a list of events. Pure function — no I/O,
 * no side effects. See spec §4.3 for behaviour contract.
 */
export function formatOvernightDigest(events: OvernightEvent[]): string {
  if (events.length === 0) {
    return '*Overnight*\n\nNo overnight activity recorded.';
  }

  const sections: string[] = ['*Overnight*'];

  // --- Errors at the top ---
  const failures = events.filter((e) => e.verdict === 'failed');
  if (failures.length > 0) {
    const errLines = failures.map((e) => `  ${e.phase}: ${e.reason}`);
    sections.push(`Errors (${failures.length}):\n${errLines.join('\n')}`);
  }

  // --- Memory / consolidate stage ---
  const consolidateEvents = events.filter((e) => e.stage === 'consolidate' && e.verdict !== 'failed');
  sections.push(renderConsolidateSection(consolidateEvents));

  // --- Operations sub-sections ---
  const opsEvents = events.filter((e) => e.stage === 'operations' && e.verdict !== 'failed');

  const backupEvents = opsEvents.filter((e) => e.phase === 'daily-backup');
  sections.push(renderOperationsPhase('Backup', 'daily-backup', backupEvents));

  const traceEvents = opsEvents.filter((e) => e.phase === 'trace-analyser');
  sections.push(renderOperationsPhase('Traces', 'trace-analyser', traceEvents));

  const sysEvents = opsEvents.filter((e) => e.phase === 'system-refresh');
  sections.push(renderOperationsPhase('System knowledge', 'system-refresh', sysEvents));

  const gtEvents = opsEvents.filter((e) => e.phase === 'ground-truth');
  sections.push(renderOperationsPhase('Ground truth', 'ground-truth', gtEvents));

  // --- Unknown phases in operations: fall through renderer ---
  const knownOps = new Set(['daily-backup', 'trace-analyser', 'system-refresh', 'ground-truth']);
  const unknownOps = opsEvents.filter((e) => !knownOps.has(e.phase));
  for (const e of unknownOps) {
    sections.push(`${e.phase}:\n  ${e.reason}`);
  }

  // --- Footer ---
  if (failures.length === 0) {
    sections.push('No errors.');
  }

  // --- Word cap + truncation ---
  const full = sections.join('\n\n');
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length <= DIGEST_WORD_CAP) {
    return full;
  }

  // Truncate at the word cap and append an omission pointer.
  const truncated = words.slice(0, DIGEST_WORD_CAP).join(' ');
  return `${truncated}\n\n... (further events omitted, open Clawd Console for full detail)`;
}

// --- Helpers ------------------------------------------------------------

function renderConsolidateSection(events: OvernightEvent[]): string {
  const heading = `${SECTION_HEADINGS.consolidate}:`;
  if (events.length === 0) {
    return `${heading}\n  not run last night (consolidate stage did not produce any events).`;
  }

  const lines: string[] = [];
  const byPhase = new Map<string, OvernightEvent[]>();
  for (const e of events) {
    const list = byPhase.get(e.phase) ?? [];
    list.push(e);
    byPhase.set(e.phase, list);
  }
  for (const [phase, phaseEvents] of byPhase) {
    const renderer = CONSOLIDATE_PHASE_COPY[phase];
    if (renderer) {
      lines.push(`  ${renderer(phaseEvents)}`);
    } else {
      lines.push(`  ${phase}: ${phaseEvents[0]!.reason}`);
    }
  }
  return `${heading}\n${lines.join('\n')}`;
}

function renderOperationsPhase(
  heading: string,
  phaseKey: string,
  events: OvernightEvent[],
): string {
  if (events.length === 0) {
    return `${heading}:\n  not run last night (${phaseKey} did not produce any events).`;
  }
  const renderer = OPERATIONS_PHASE_COPY[phaseKey];
  const body = renderer ? renderer(events) : `${events[0]!.reason}`;
  return `${heading}:\n  ${body}`;
}
