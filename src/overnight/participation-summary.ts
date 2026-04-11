// src/overnight/participation-summary.ts — aggregates group participation decision
// records for the morning report (UTC calendar day, matches report `date` prefix).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { countParticipationTaggedInteractionsOnDate } from '../interaction-log.js';
import { countParticipationTaggedTracesOnDate } from '../reasoning-trace.js';

/** Counts derived from data/runtime/participation-decisions.jsonl for one report day. */
export interface ParticipationLearningSummary {
  reviewed: number;
  accepted: number;
  overstayed: number;
  missedOpenings: number;
  crossChecks?: {
    taggedInteractions: number;
    taggedTraces: number;
  };
}

const DECISIONS_REL = join('data', 'runtime', 'participation-decisions.jsonl');

/** Policy decline reasons we surface as "missed opening" proxies (signal present, no intervention). */
const MISSED_OPENING_REASONS = new Set([
  'model_below_threshold',
  'heuristic_below_threshold',
]);

interface DecisionLine {
  timestamp?: string;
  shouldIntervene?: boolean;
  reason?: string;
}

function parseLine(line: string): DecisionLine | null {
  try {
    return JSON.parse(line) as DecisionLine;
  } catch {
    return null;
  }
}

/**
 * Load participation decision aggregates for isoDate (YYYY-MM-DD) from the on-disk JSONL log.
 * Returns null when the file is missing or there are no rows for that UTC day.
 */
export function loadParticipationLearningSummary(
  isoDate: string,
  repoRoot: string,
): ParticipationLearningSummary | null {
  const path = join(repoRoot, DECISIONS_REL);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.trim().split('\n').filter(Boolean);
  const day: DecisionLine[] = [];
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec?.timestamp?.startsWith(isoDate)) continue;
    day.push(rec);
  }
  if (day.length === 0) return null;

  let accepted = 0;
  let overstayed = 0;
  let missedOpenings = 0;
  for (const r of day) {
    if (r.shouldIntervene) accepted += 1;
    const reason = String(r.reason ?? '');
    if (reason.toLowerCase().includes('overstay')) overstayed += 1;
    if (MISSED_OPENING_REASONS.has(reason)) missedOpenings += 1;
  }

  const taggedInteractions = countParticipationTaggedInteractionsOnDate(isoDate, repoRoot);
  const taggedTraces = countParticipationTaggedTracesOnDate(isoDate, repoRoot);
  return {
    reviewed: day.length,
    accepted,
    overstayed,
    missedOpenings,
    crossChecks: {
      taggedInteractions,
      taggedTraces,
    },
  };
}

/** Plain-text block for the WhatsApp report (evidence-first, labels proxies). */
export function renderParticipationLearningSummaryBlock(
  summary: ParticipationLearningSummary,
  isoDate: string,
): string {
  const lines = [
    `Participation learning (ambient decision log, UTC ${isoDate}):`,
    `  Reviewed ${summary.reviewed} decisions; ${summary.accepted} interventions accepted.`,
    `  Overstayed (explicit reason contains "overstay"): ${summary.overstayed}.`,
    `  Missed openings (proxy — declined after model/heuristic gate): ${summary.missedOpenings}.`,
  ];
  const crossChecks = summary.crossChecks;
  if (crossChecks) {
    lines.push(
      `  Cross-checks: ${crossChecks.taggedInteractions} interaction logs and ${crossChecks.taggedTraces} reasoning traces tagged with participation.`,
    );
  }
  return lines.join('\n');
}
