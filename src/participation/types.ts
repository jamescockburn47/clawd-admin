/** How the bot may contribute in a group without a direct @mention. */
export type ParticipationPosture =
  | 'direct_only'
  | 'rare_high_confidence'
  | 'active_participant';

/** Group security / restriction tier (from group registry or caller). */
export type GroupMode = 'open' | 'project' | 'colleague';

/** Resolved participation settings plus identity fields from the current request. */
export interface ParticipationProfile {
  chatJid: string;
  groupLabel: string;
  groupMode: GroupMode;
  posture: ParticipationPosture;
  researchEnabled: boolean;
  memoryRecallEnabled: boolean;
  maxUnsolicitedPerHour: number;
  followUpWindowMs: number;
  cooldownMs: number;
}

/** Input needed to resolve a profile; security mode is always supplied by the caller. */
export interface ParticipationProfileInput {
  chatJid: string;
  groupLabel: string;
  groupMode: GroupMode;
}

/**
 * What a human reply is "aimed at" for threading / follow-up correlation.
 * Kept minimal for in-memory state; wire-up from Baileys happens upstream later.
 */
export type ReplyTarget = { kind: 'quoted'; messageId: string; senderName: string };

/** Persisted per-group fields (no groupMode / label — those come from authority elsewhere). */
export interface ParticipationOverride {
  posture?: ParticipationPosture;
  researchEnabled?: boolean;
  memoryRecallEnabled?: boolean;
  maxUnsolicitedPerHour?: number;
  followUpWindowMs?: number;
  cooldownMs?: number;
}
