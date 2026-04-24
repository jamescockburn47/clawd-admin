/// <reference types="node" />
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTICIPATION_DEFAULTS } from './constants.js';
import type {
  ParticipationOverride,
  ParticipationProfile,
  ParticipationProfileInput,
} from './types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_STORE_FILE = join(REPO_ROOT, 'data', 'runtime', 'group-participation.json');

const PERSIST_VERSION = 1 as const;

interface PersistedFile {
  version: typeof PERSIST_VERSION;
  overrides: Record<string, ParticipationOverride>;
}

function emptyPersisted(): PersistedFile {
  return { version: PERSIST_VERSION, overrides: {} };
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(x);
  return prototype === Object.prototype || prototype === null;
}

function isPersistedFile(x: unknown): x is PersistedFile {
  if (!isPlainObject(x)) return false;
  return x.version === PERSIST_VERSION && isPlainObject(x.overrides);
}

class ParticipationPolicyService {
  constructor(private readonly storeFile: string) {}

  getStoreFile(): string {
    return this.storeFile;
  }

  private loadPersisted(): PersistedFile {
    if (!existsSync(this.storeFile)) {
      return emptyPersisted();
    }
    try {
      const raw = readFileSync(this.storeFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedFile(parsed)) {
        console.error('group-participation: ignoring invalid persistence file', {
          path: this.storeFile,
          reason: 'invalid shape',
        });
        return emptyPersisted();
      }
      return parsed;
    } catch (err) {
      console.error('group-participation: failed to read persistence file', {
        path: this.storeFile,
        err: err instanceof Error ? err.message : String(err),
      });
      return emptyPersisted();
    }
  }

  private writePersisted(data: PersistedFile): void {
    mkdirSync(dirname(this.storeFile), { recursive: true });
    writeFileSync(this.storeFile, JSON.stringify(data, null, 2), 'utf8');
  }

  getParticipationProfile(input: ParticipationProfileInput): ParticipationProfile {
    const data = this.loadPersisted();
    const override = data.overrides[input.chatJid];
    const merged = applyOverride(baseFromDefaults(), override ?? {});
    return {
      chatJid: input.chatJid,
      groupLabel: input.groupLabel,
      groupMode: input.groupMode,
      ...merged,
    };
  }

  mergeParticipationProfile(chatJid: string, patch: ParticipationOverride): void {
    const data = this.loadPersisted();
    const prev = data.overrides[chatJid] ?? {};
    data.overrides[chatJid] = { ...prev, ...patch };
    this.writePersisted(data);
  }

  resetForTest(): string {
    this.writePersisted(emptyPersisted());
    return this.storeFile;
  }
}

let activeService = new ParticipationPolicyService(DEFAULT_STORE_FILE);

function baseFromDefaults(): Omit<
  ParticipationProfile,
  'chatJid' | 'groupLabel' | 'groupMode'
> {
  return { ...PARTICIPATION_DEFAULTS };
}

function applyOverride(
  base: Omit<ParticipationProfile, 'chatJid' | 'groupLabel' | 'groupMode'>,
  o: ParticipationOverride,
): Omit<ParticipationProfile, 'chatJid' | 'groupLabel' | 'groupMode'> {
  return {
    posture: o.posture ?? base.posture,
    researchEnabled: o.researchEnabled ?? base.researchEnabled,
    memoryRecallEnabled: o.memoryRecallEnabled ?? base.memoryRecallEnabled,
    maxUnsolicitedPerHour: o.maxUnsolicitedPerHour ?? base.maxUnsolicitedPerHour,
    followUpWindowMs: o.followUpWindowMs ?? base.followUpWindowMs,
    cooldownMs: o.cooldownMs ?? base.cooldownMs,
  };
}

/**
 * Returns the effective participation profile for a group, merging defaults,
 * stored overrides, and caller-supplied identity (including security mode).
 */
export function getParticipationProfile(input: ParticipationProfileInput): ParticipationProfile {
  return activeService.getParticipationProfile(input);
}

/**
 * Merges participation-only fields for a group JID and persists. Does not store
 * group security mode; callers supply `groupMode` on each `getParticipationProfile` read.
 */
export function mergeParticipationProfile(
  chatJid: string,
  patch: ParticipationOverride,
): void {
  activeService.mergeParticipationProfile(chatJid, patch);
}

/**
 * Points persistence at an empty temp file (for tests). Production code leaves the default path.
 */
export function resetParticipationProfilesForTest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'group-participation-test-'));
  activeService = new ParticipationPolicyService(join(dir, 'group-participation.json'));
  return activeService.resetForTest();
}
