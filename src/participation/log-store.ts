/// <reference types="node" />
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReplyTarget } from './types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_STORE_FILE = join(REPO_ROOT, 'data', 'runtime', 'participation-decisions.jsonl');
const MAX_RECENT_DECISIONS = 200;

export interface ParticipationDecisionRecord {
  timestamp: string;
  chatJid: string;
  shouldIntervene: boolean;
  interventionType: string | null;
  reason: string;
  confidence: number;
  replyTarget?: ReplyTarget | null;
  followUpWindowOpen?: boolean;
  followUpTurnIndex?: number | null;
  profilePosture?: string | null;
  plannedRole?: string | null;
}

type AppendParticipationDecisionInput = Omit<ParticipationDecisionRecord, 'timestamp'>;

class ParticipationLogStore {
  private readonly recentEntries: ParticipationDecisionRecord[] = [];

  constructor(private storeFile: string) {}

  append(input: AppendParticipationDecisionInput): void {
    const entry: ParticipationDecisionRecord = {
      timestamp: new Date().toISOString(),
      ...input,
      interventionType: input.interventionType ?? null,
      replyTarget: input.replyTarget ?? null,
      followUpWindowOpen: input.followUpWindowOpen ?? false,
      followUpTurnIndex: input.followUpTurnIndex ?? null,
      profilePosture: input.profilePosture ?? null,
      plannedRole: input.plannedRole ?? null,
    };

    this.recentEntries.push(entry);
    while (this.recentEntries.length > MAX_RECENT_DECISIONS) {
      this.recentEntries.shift();
    }

    mkdirSync(dirname(this.storeFile), { recursive: true });
    appendFileSync(this.storeFile, JSON.stringify(entry) + '\n', 'utf8');
  }

  getRecent(limit: number): ParticipationDecisionRecord[] {
    const safeLimit = Math.max(0, limit);
    if (safeLimit === 0) {
      return [];
    }
    return this.recentEntries.slice(-safeLimit).reverse().map((entry) => ({
      ...entry,
      replyTarget: entry.replyTarget ? { ...entry.replyTarget } : null,
    }));
  }

  resetForTest(): string {
    this.recentEntries.length = 0;
    mkdirSync(dirname(this.storeFile), { recursive: true });
    writeFileSync(this.storeFile, '', 'utf8');
    return this.storeFile;
  }
}

let activeStore = new ParticipationLogStore(DEFAULT_STORE_FILE);

/** Appends one structured participation decision for recent diagnostics and console reads. */
export function appendParticipationDecision(input: AppendParticipationDecisionInput): void {
  activeStore.append(input);
}

/** Returns newest-first participation decisions from the in-memory recent ring buffer. */
export function getRecentParticipationDecisions(limit = 20): ParticipationDecisionRecord[] {
  return activeStore.getRecent(limit);
}

/** Resets the active store to an empty temp-backed file for test isolation. */
export function resetParticipationLogsForTest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'participation-log-store-'));
  activeStore = new ParticipationLogStore(join(dir, 'participation-decisions.jsonl'));
  return activeStore.resetForTest();
}
