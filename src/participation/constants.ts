import type { ParticipationPosture } from './types.js';

/** Default posture for groups with no stored override. */
export const DEFAULT_POSTURE: ParticipationPosture = 'direct_only';

export const DEFAULT_RESEARCH_ENABLED = true;
export const DEFAULT_MEMORY_RECALL_ENABLED = true;

/** Cap on ambient / unsolicited contributions per wall-clock hour. */
export const DEFAULT_MAX_UNSOLICITED_PER_HOUR = 2;

/** Window after a direct interaction where follow-up context applies. */
export const DEFAULT_FOLLOW_UP_WINDOW_MS = 120_000;

/** Minimum spacing between unsolicited contributions for the same group. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Max turns retained per group for rolling in-memory conversation state. */
export const MAX_ROLLING_TURNS_PER_CHAT = 100;

/** Hard cap on consecutive follow-up turns before Clint must disengage. */
export const MAX_FOLLOW_UP_TURNS_PER_WINDOW = 3;

/** Single object with default participation tuning (excluding per-request identity fields). */
export const PARTICIPATION_DEFAULTS = {
  posture: DEFAULT_POSTURE,
  researchEnabled: DEFAULT_RESEARCH_ENABLED,
  memoryRecallEnabled: DEFAULT_MEMORY_RECALL_ENABLED,
  maxUnsolicitedPerHour: DEFAULT_MAX_UNSOLICITED_PER_HOUR,
  followUpWindowMs: DEFAULT_FOLLOW_UP_WINDOW_MS,
  cooldownMs: DEFAULT_COOLDOWN_MS,
} as const;
