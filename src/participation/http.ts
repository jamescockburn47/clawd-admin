/// <reference types="node" />
import { PARTICIPATION_DEFAULTS } from './constants.js';
import type { ParticipationDecisionRecord } from './log-store.js';
import type { GroupMode, ParticipationPosture } from './types.js';

/** Input for dashboard summaries; optional fields default like unregistered-safe group policy. */
export interface ParticipationSummaryInput {
  chatJid: string;
  groupLabel: string;
  posture: ParticipationPosture;
  maxUnsolicitedPerHour: number;
  followUpWindowMs: number;
  groupMode?: GroupMode;
  researchEnabled?: boolean;
  memoryRecallEnabled?: boolean;
  cooldownMs?: number;
}

/** Console- and operator-safe participation row (no raw blocked-topic payloads). */
export interface ParticipationGroupSummaryJson {
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

const DEFAULT_GROUP_MODE: GroupMode = 'colleague';

/** Upper bound for `?limit=` on `/api/participation/decisions` (aligned with log-store ring buffer). */
export const PARTICIPATION_DECISIONS_RESPONSE_CAP = 200;

/** Default `?limit=` for `/api/participation/decisions` when callers omit the query. */
export const DEFAULT_PARTICIPATION_DECISIONS_PAGE_SIZE = 50;

/** Builds a compact, non-sensitive summary for dashboard JSON. */
export function buildParticipationSummary(
  input: ParticipationSummaryInput,
): ParticipationGroupSummaryJson {
  return {
    chatJid: input.chatJid,
    groupLabel: input.groupLabel,
    groupMode: input.groupMode ?? DEFAULT_GROUP_MODE,
    posture: input.posture,
    researchEnabled: input.researchEnabled ?? PARTICIPATION_DEFAULTS.researchEnabled,
    memoryRecallEnabled:
      input.memoryRecallEnabled ?? PARTICIPATION_DEFAULTS.memoryRecallEnabled,
    maxUnsolicitedPerHour: input.maxUnsolicitedPerHour,
    followUpWindowMs: input.followUpWindowMs,
    cooldownMs: input.cooldownMs ?? PARTICIPATION_DEFAULTS.cooldownMs,
  };
}

/** One decision row for GET /api/participation/decisions (matches console contract). */
export interface ParticipationDecisionJson {
  timestamp: string;
  chatJid: string;
  shouldIntervene: boolean;
  interventionType: string | null;
  reason: string;
  confidence: number;
  replyTarget: ParticipationDecisionRecord['replyTarget'];
  followUpWindowOpen: boolean;
  followUpTurnIndex: number | null;
  profilePosture: string | null;
  plannedRole: string | null;
}

/** Maps ring-buffer records to API-safe decision objects. */
export function serializeParticipationDecisionsForApi(
  records: ParticipationDecisionRecord[],
): { decisions: ParticipationDecisionJson[] } {
  return {
    decisions: records.map((r) => ({
      timestamp: r.timestamp,
      chatJid: r.chatJid,
      shouldIntervene: r.shouldIntervene,
      interventionType: r.interventionType ?? null,
      reason: r.reason,
      confidence: r.confidence,
      replyTarget: r.replyTarget ?? null,
      followUpWindowOpen: r.followUpWindowOpen ?? false,
      followUpTurnIndex: r.followUpTurnIndex ?? null,
      profilePosture: r.profilePosture ?? null,
      plannedRole: r.plannedRole ?? null,
    })),
  };
}
