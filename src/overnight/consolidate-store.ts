// src/overnight/consolidate-store.ts — validated storage + rejection logger.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1.
//
// For each candidate produced by ConsolidateExtractor:
//   - run the validator (consolidate-validate.ts)
//   - on valid → call StoreClient.storeValidated()
//   - on invalid → append to data/overnight/rejected-<date>.jsonl with reason
// Store failures are recorded in storeErrors and do not stop processing.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate, type MemoryCandidate } from './consolidate-validate.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(REPO_ROOT, 'data', 'overnight');

export interface StoreClient {
  /** Store a candidate that has passed validation. */
  storeValidated(candidate: MemoryCandidate): Promise<void>;
}

export interface ConsolidateStoreOptions {
  client: StoreClient;
  overnightDir?: string;
}

export interface StoreError {
  candidate: MemoryCandidate;
  reason: string;
}

export interface StoreResult {
  stored: number;
  rejected: number;
  storeErrors: StoreError[];
}

export interface ProcessInput {
  candidates: MemoryCandidate[];
  date: string;
}

export class ConsolidateStore {
  private readonly overnightDir: string;

  constructor(private readonly opts: ConsolidateStoreOptions) {
    this.overnightDir = opts.overnightDir ?? DEFAULT_OVERNIGHT_DIR;
  }

  async process(input: ProcessInput): Promise<StoreResult> {
    const result: StoreResult = { stored: 0, rejected: 0, storeErrors: [] };
    if (input.candidates.length === 0) return result;

    const rejectedFile = join(this.overnightDir, `rejected-${input.date}.jsonl`);
    let rejectedDirEnsured = false;

    for (const candidate of input.candidates) {
      const validation = validateCandidate(candidate);
      if (!validation.valid) {
        if (!rejectedDirEnsured) {
          await mkdir(this.overnightDir, { recursive: true });
          rejectedDirEnsured = true;
        }
        const entry = {
          timestamp: new Date().toISOString(),
          reason: validation.reason ?? 'unknown',
          candidate,
        };
        await appendFile(rejectedFile, JSON.stringify(entry) + '\n', 'utf8');
        result.rejected += 1;
        continue;
      }

      try {
        await this.opts.client.storeValidated(candidate);
        result.stored += 1;
      } catch (err) {
        result.storeErrors.push({ candidate, reason: (err as Error).message });
      }
    }

    return result;
  }
}
