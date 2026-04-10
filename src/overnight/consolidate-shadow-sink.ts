// src/overnight/consolidate-shadow-sink.ts — file-based StoreClient for shadow mode.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-phase1-shadow-mode-design.md §4.2.
//
// Implements the StoreClient interface from consolidate-store.ts but writes
// validated candidates to a per-day JSONL file instead of calling EVO's
// memory service. Used only during the three-night shadow soak; replaced by
// a real memory-store client at cutover.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoreClient } from './consolidate-store.js';
import type { MemoryCandidate } from './consolidate-validate.js';

export interface ShadowSinkOptions {
  /** Absolute path to the overnight data directory (e.g. data/overnight). */
  overnightDir: string;
  /** YYYY-MM-DD date used in the output filename. */
  todayStr: string;
}

/**
 * File-based sink that appends validated candidates as JSONL to
 * `<overnightDir>/shadow-candidates-<todayStr>.jsonl`. One line per candidate.
 */
export class ShadowSink implements StoreClient {
  private readonly filePath: string;
  private dirEnsured = false;

  constructor(private readonly opts: ShadowSinkOptions) {
    this.filePath = join(opts.overnightDir, `shadow-candidates-${opts.todayStr}.jsonl`);
  }

  /** Append one candidate to the shadow file. Creates the directory on first call. */
  async storeValidated(candidate: MemoryCandidate): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.opts.overnightDir, { recursive: true });
      this.dirEnsured = true;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      candidate,
    };
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
  }
}
