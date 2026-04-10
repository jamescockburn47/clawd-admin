// src/overnight/events.ts — append-only event log for overnight stages.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §5.4.
//
// One file per night at data/overnight/events-<YYYY-MM-DD>.jsonl.
// Every stage writes events here; queryEvents() is the single read path.
// "No event = did not happen" — silent success is impossible by construction.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(REPO_ROOT, 'data', 'overnight');

export const OVERNIGHT_STAGES = ['consolidate', 'probe', 'report', 'improve'] as const;
export type OvernightStage = (typeof OVERNIGHT_STAGES)[number];

export const OVERNIGHT_VERDICTS = ['ok', 'rejected', 'failed', 'skipped', 'null'] as const;
export type OvernightVerdict = (typeof OVERNIGHT_VERDICTS)[number];

export interface OvernightEvent {
  id: string;
  timestamp: string; // ISO 8601
  stage: OvernightStage;
  phase: string;
  inputs: string[];
  outputs: string[];
  verdict: OvernightVerdict;
  reason: string;
  evidence_refs: string[];
  rollback_ref: string | null; // git sha if applicable
  budget: {
    opus_sessions: number;
    tokens: number;
  };
}

export interface AppendEventOptions {
  date?: string; // YYYY-MM-DD, defaults to today (UTC)
  overnightDir?: string;
}

export interface QueryEventsOptions {
  date: string; // YYYY-MM-DD
  stage?: OvernightStage;
  overnightDir?: string;
}

/** Resolve the log file path for a given date. */
export function eventLogPath(date: string, opts: { overnightDir?: string } = {}): string {
  const dir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  return join(dir, `events-${date}.jsonl`);
}

/** Append a new event. Fills in id and timestamp. Validates shape. */
export async function appendEvent(
  event: Omit<OvernightEvent, 'id' | 'timestamp'>,
  opts: AppendEventOptions = {},
): Promise<OvernightEvent> {
  validateEvent(event);

  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;

  const written: OvernightEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...event,
  };

  const file = eventLogPath(date, { overnightDir });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(written) + '\n', 'utf8');
  return written;
}

/** Query events for a specific date, optionally filtered by stage. */
export async function queryEvents(opts: QueryEventsOptions): Promise<OvernightEvent[]> {
  const file = eventLogPath(opts.date, { overnightDir: opts.overnightDir });
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const events = raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OvernightEvent);

  return opts.stage ? events.filter((e) => e.stage === opts.stage) : events;
}

function validateEvent(event: Omit<OvernightEvent, 'id' | 'timestamp'>): void {
  const required: (keyof Omit<OvernightEvent, 'id' | 'timestamp'>)[] = [
    'stage', 'phase', 'inputs', 'outputs', 'verdict', 'reason', 'evidence_refs', 'rollback_ref', 'budget',
  ];
  for (const key of required) {
    if (!(key in event)) {
      throw new Error(`invalid event: missing required field "${key}"`);
    }
  }
  if (!OVERNIGHT_STAGES.includes(event.stage)) {
    throw new Error(`invalid event: stage "${event.stage}" not in ${OVERNIGHT_STAGES.join('|')}`);
  }
  if (!OVERNIGHT_VERDICTS.includes(event.verdict)) {
    throw new Error(`invalid event: verdict "${event.verdict}" not in ${OVERNIGHT_VERDICTS.join('|')}`);
  }
  if (!Array.isArray(event.inputs) || !Array.isArray(event.outputs) || !Array.isArray(event.evidence_refs)) {
    throw new Error('invalid event: inputs, outputs, and evidence_refs must be arrays');
  }
  if (typeof event.budget?.opus_sessions !== 'number' || typeof event.budget?.tokens !== 'number') {
    throw new Error('invalid event: budget.opus_sessions and budget.tokens must be numbers');
  }
}
