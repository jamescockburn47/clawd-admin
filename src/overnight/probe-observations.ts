// src/overnight/probe-observations.ts — weekly observation log I/O.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.2, §5.6.
//
// Observations accumulate for 7 days in data/overnight/observations-<iso-week>.jsonl,
// then roll over to data/overnight/archive/ on Monday. Four kinds of observations:
// pattern, candidate, drift, quality_failure. Pure file I/O + ISO-week math; no
// external dependencies beyond node:fs.

import { appendFile, readFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(REPO_ROOT, 'data', 'overnight');
const ARCHIVE_SUBDIR = 'archive';

export type ObservationKind = 'pattern' | 'candidate' | 'drift' | 'quality_failure';

/** Base fields shared by all observation kinds. */
interface ObservationBase {
  kind: ObservationKind;
  /** YYYY-MM-DD when the observation was recorded. */
  date: string;
  /** References to traces, log lines, or other evidence. */
  evidence_refs: string[];
  /** Weight used by the weekly grooming pass. Decays over time. */
  weight: number;
}

export interface PatternObservation extends ObservationBase {
  kind: 'pattern';
  observation: string;
}

export interface CandidateObservation extends ObservationBase {
  kind: 'candidate';
  title: string;
  category: string;
  predicted_benefit: string;
  scope: string;
  rough_cost: string;
}

export interface DriftObservation extends ObservationBase {
  kind: 'drift';
  original_timestamp: string;
  input_hash: string;
  diff_summary: string;
  judged: 'better' | 'worse' | 'neutral';
  reason: string;
}

export interface QualityFailureObservation extends ObservationBase {
  kind: 'quality_failure';
  category: string;
  cortex_summary?: string;
  memory_count?: number;
  tools_fired?: string[];
  rejection_reason: string;
}

export type Observation =
  | PatternObservation
  | CandidateObservation
  | DriftObservation
  | QualityFailureObservation;

export interface ObservationOptions {
  overnightDir?: string;
}

export interface AppendObservationOptions extends ObservationOptions {
  isoWeek: string;
}

export interface QueryObservationOptions extends ObservationOptions {
  isoWeek: string;
  kind?: ObservationKind;
}

export interface RolloverResult {
  archivedWeek: string | null;
}

/**
 * Compute the ISO 8601 week identifier for a given date.
 *
 * Returns a string of the form `YYYY-Wnn`, where YYYY is the ISO week-year
 * (not necessarily the calendar year) and nn is the zero-padded week number
 * (1-53). ISO weeks begin on Monday.
 */
export function isoWeekOf(date: Date): string {
  // Copy the date and normalise to UTC midnight
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of the current ISO week (ISO weeks are Mon-Sun, Thursday is week-year anchor)
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const weekYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const dayDiff = (d.getTime() - yearStart.getTime()) / 86400000;
  const weekNum = Math.ceil((dayDiff + 1) / 7);
  const paddedWeek = weekNum.toString().padStart(2, '0');
  return `${weekYear}-W${paddedWeek}`;
}

/** Parse an iso-week key like "2026-W15" into its numeric components. */
export function parseIsoWeek(isoWeek: string): { year: number; week: number } {
  const match = isoWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!match) throw new Error(`invalid iso-week: ${isoWeek}`);
  return { year: parseInt(match[1]!, 10), week: parseInt(match[2]!, 10) };
}

/** Return the iso-week key for the week *before* the given one. */
export function previousIsoWeek(isoWeek: string): string {
  const { year, week } = parseIsoWeek(isoWeek);
  if (week > 1) {
    return `${year}-W${(week - 1).toString().padStart(2, '0')}`;
  }
  // Week 1 → previous year; figure out if the prior year had 52 or 53 weeks.
  // The prior week is the last week of (year - 1).
  const dec28 = new Date(Date.UTC(year - 1, 11, 28));
  return isoWeekOf(dec28);
}

/** Resolve the observation log path for a given iso-week. */
export function observationLogPath(isoWeek: string, opts: ObservationOptions = {}): string {
  const dir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  return join(dir, `observations-${isoWeek}.jsonl`);
}

/** Resolve the archived observation log path for a given iso-week. */
export function archiveObservationLogPath(isoWeek: string, opts: ObservationOptions = {}): string {
  const dir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  return join(dir, ARCHIVE_SUBDIR, `observations-${isoWeek}.jsonl`);
}

/**
 * Append one observation to the given iso-week's log file. Creates the
 * directory if needed. Does not validate schema beyond requiring a `kind`
 * field — callers are expected to construct valid payloads.
 */
export async function appendObservation(
  observation: Observation,
  opts: AppendObservationOptions,
): Promise<void> {
  if (!observation.kind) {
    throw new Error('observation missing required "kind" field');
  }
  const overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  const file = observationLogPath(opts.isoWeek, { overnightDir });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(observation) + '\n', 'utf8');
}

/**
 * Read all observations for a given iso-week, optionally filtered by kind.
 * Skips malformed JSONL lines (logs silently — intentional, matches Phase 0
 * events.ts behaviour).
 */
export async function queryObservations(
  opts: QueryObservationOptions,
): Promise<Observation[]> {
  const overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  const file = observationLogPath(opts.isoWeek, { overnightDir });
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const observations: Observation[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      observations.push(JSON.parse(line) as Observation);
    } catch {
      // intentional: skip malformed lines, keep going
    }
  }

  if (opts.kind) {
    return observations.filter((o) => o.kind === opts.kind);
  }
  return observations;
}

/**
 * On Monday, move last week's observation log to the archive directory.
 * No-op on other days or when last week's log does not exist.
 */
export async function rolloverIfMonday(
  now: Date,
  opts: ObservationOptions = {},
): Promise<RolloverResult> {
  // JavaScript getUTCDay: Sunday=0, Monday=1
  if (now.getUTCDay() !== 1) return { archivedWeek: null };

  const currentWeek = isoWeekOf(now);
  const lastWeek = previousIsoWeek(currentWeek);

  const overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  const src = observationLogPath(lastWeek, { overnightDir });
  if (!existsSync(src)) return { archivedWeek: null };

  const dst = archiveObservationLogPath(lastWeek, { overnightDir });
  await mkdir(dirname(dst), { recursive: true });
  await rename(src, dst);
  return { archivedWeek: lastWeek };
}

/**
 * Apply decay to an observation's weight based on its age relative to now.
 * Observations older than 14 days get weight halved every week. Observations
 * older than 12 weeks get weight zeroed (dropped from active selection).
 */
export function decayedWeight(
  observation: Observation,
  nowMs: number = Date.now(),
): number {
  const obsMs = new Date(observation.date + 'T12:00:00Z').getTime();
  const ageDays = (nowMs - obsMs) / 86400000;
  if (ageDays < 14) return observation.weight;
  if (ageDays > 84) return 0; // 12 weeks
  const weeksPast14 = Math.floor((ageDays - 14) / 7);
  return observation.weight * Math.pow(0.5, weeksPast14 + 1);
}
