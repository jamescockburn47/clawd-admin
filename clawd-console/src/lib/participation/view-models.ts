import type {
  OvernightEvent,
  ParticipationDecision,
  ParticipationGroupMode,
  ParticipationGroupSummary,
  ParticipationPosture,
} from '@/lib/types';

export const FOLLOW_UP_TURN_CAP = 3;

export type InstructionStackOrigin = 'inherited' | 'override' | 'computed';

export interface InstructionStackRow {
  layer: string;
  summary: string;
  origin: InstructionStackOrigin;
}

const LAYER_SECURITY = 'Security/privacy restrictions';
const LAYER_PARTICIPATION = 'Participation policy';
const LAYER_TIMING = 'Timing and initiative';

function securitySummaryForMode(mode: ParticipationGroupMode): string {
  switch (mode) {
    case 'open':
      return 'Inherited from group registry: topic guardrails apply; personal admin tools (calendar, email, travel, todos) never run in groups. Memories and dreams may be recalled when enabled.';
    case 'project':
      return 'Inherited: work/project guardrails with tighter extraction and role assumptions; personal admin tools remain blocked in groups.';
    case 'colleague':
      return 'Inherited: colleague posture — most restrictive defaults for mixed or untrusted rooms; minimise unsolicited surface area and sensitive recall.';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function participationSummary(params: {
  mode: ParticipationGroupMode;
  posture: ParticipationPosture;
  followUpWindowMs: number;
}): string {
  const modeLabel = formatGroupMode(params.mode);
  const postureLabel = formatPosture(params.posture);
  const window = formatDurationMs(params.followUpWindowMs);
  return `Group mode ${modeLabel}. Active posture: ${postureLabel}. Direct replies open a follow-up window of ${window} (overrides base tuning when stricter).`;
}

function timingSummary(posture: ParticipationPosture, followUpWindowMs: number): string {
  const window = formatDurationMs(followUpWindowMs);
  return `Unsolicited cadence follows posture (${formatPosture(posture)}). Follow-up turns are capped at ${FOLLOW_UP_TURN_CAP} within each ${window} window before disengaging (computed).`;
}

export function buildInstructionStackRows(params: {
  mode: ParticipationGroupMode;
  posture: ParticipationPosture;
  followUpWindowMs: number;
}): InstructionStackRow[] {
  return [
    {
      layer: LAYER_SECURITY,
      summary: securitySummaryForMode(params.mode),
      origin: 'inherited',
    },
    {
      layer: LAYER_PARTICIPATION,
      summary: participationSummary(params),
      origin: 'override',
    },
    {
      layer: LAYER_TIMING,
      summary: timingSummary(params.posture, params.followUpWindowMs),
      origin: 'computed',
    },
  ];
}

export function formatGroupMode(mode: ParticipationGroupMode): string {
  switch (mode) {
    case 'open':
      return 'open';
    case 'project':
      return 'project';
    case 'colleague':
      return 'colleague';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function formatPosture(posture: ParticipationPosture): string {
  switch (posture) {
    case 'direct_only':
      return 'direct-only (ambient speech disabled)';
    case 'rare_high_confidence':
      return 'rare, high-confidence ambient contributions only';
    case 'active_participant':
      return 'active participant (higher ambient allowance)';
    default: {
      const _exhaustive: never = posture;
      return _exhaustive;
    }
  }
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0s';
  }
  const sec = Math.round(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min} min` : `${min} min ${rem}s`;
}

export function formatDecisionHighlights(
  decisions: ParticipationDecision[],
  chatJid: string,
  limit: number
): ParticipationDecision[] {
  const filtered = decisions.filter((d) => d.chatJid === chatJid);
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  return sorted.slice(0, Math.max(0, Math.trunc(limit)));
}

export interface GroupCardModel {
  summary: ParticipationGroupSummary;
  recentDecisionCount: number;
  lastInterventionAt: string | null;
}

export function buildGroupCardModel(
  summary: ParticipationGroupSummary,
  decisions: ParticipationDecision[]
): GroupCardModel {
  const forGroup = decisions.filter((d) => d.chatJid === summary.chatJid);
  const newestFirst = [...forGroup].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const withIntervention = newestFirst.filter((d) => d.shouldIntervene);
  const last = withIntervention[0]?.timestamp ?? null;
  return {
    summary,
    recentDecisionCount: newestFirst.length,
    lastInterventionAt: last,
  };
}

export function buildRolePlaybookLines(posture: ParticipationPosture): string[] {
  switch (posture) {
    case 'direct_only':
      return [
        'Speak only when explicitly addressed (mention, prefix, or clear reply thread).',
        'Do not initiate ambient contributions; planner skips proactive roles.',
        'Quoted reply preferred when answering a specific message.',
      ];
    case 'rare_high_confidence':
      return [
        'Ambient contributions require high classifier confidence and clear marginal value.',
        'Prefer synthesis, correction, or missing context over generic agreement.',
        'If uncertain, stay silent — anti-irritation beats coverage.',
      ];
    case 'active_participant':
      return [
        'May propose clarifications and next steps when they reduce collective confusion.',
        'Still respect rate limits and thread anchoring — never flood the channel.',
        'Escalate to direct-only behaviour if the room signals fatigue or pushback.',
      ];
    default: {
      const _exhaustive: never = posture;
      return _exhaustive;
    }
  }
}

export function buildFollowUpPlaybookLines(followUpWindowMs: number): string[] {
  const window = formatDurationMs(followUpWindowMs);
  return [
    `After a direct engagement, follow-ups within ${window} reuse conversation state (rolling thread).`,
    `At most ${FOLLOW_UP_TURN_CAP} consecutive bot turns inside the window; then disengage unless newly addressed.`,
    'Mic / voice follow-up rules on device: flush audio before reopening the mic after TTS.',
  ];
}

export interface ParticipationMissionSummaryParams {
  defaultPosture: ParticipationPosture;
  cooldownState: 'active' | 'inactive' | 'unknown';
  interventionRate: number;
}

export function buildParticipationMissionSummary(params: ParticipationMissionSummaryParams): string {
  const clamped = Math.max(0, Math.min(1, params.interventionRate));
  const pct = Math.round(clamped * 100);
  const cooldownLabel =
    params.cooldownState === 'unknown'
      ? 'not yet surfaced'
      : params.cooldownState;
  return `Default posture ${params.defaultPosture}. Cooldown ${cooldownLabel}. Recent intervention-rate proxy ${pct}%.`;
}

function pickDefaultPosture(groups: ParticipationGroupSummary[]): ParticipationPosture {
  if (groups.length === 0) {
    return 'rare_high_confidence';
  }
  const tally = new Map<ParticipationPosture, number>();
  for (const g of groups) {
    tally.set(g.posture, (tally.get(g.posture) ?? 0) + 1);
  }
  let top = groups[0]!.posture;
  let max = -1;
  for (const [posture, n] of tally) {
    if (n > max) {
      max = n;
      top = posture;
    }
  }
  return top;
}

function computeInterventionRate(decisions: ParticipationDecision[]): number {
  if (decisions.length === 0) {
    return 0;
  }
  const intervened = decisions.filter((d) => d.shouldIntervene).length;
  return intervened / decisions.length;
}

export function deriveParticipationMissionInputs(
  groups: ParticipationGroupSummary[],
  decisions: ParticipationDecision[]
): ParticipationMissionSummaryParams {
  return {
    defaultPosture: pickDefaultPosture(groups),
    cooldownState: 'unknown',
    interventionRate: computeInterventionRate(decisions),
  };
}

const MEMORY_LENS_TAB_ORDER = [
  'all memories',
  'identity',
  'interaction history',
  'style notes',
] as const;

export function getMemoryLensTabs(): string[] {
  return [...MEMORY_LENS_TAB_ORDER];
}

export interface MemoryLensSlice {
  fact: string;
  category: string;
  tags: string[];
}

export function memoryMatchesLens(memory: MemoryLensSlice, lens: string): boolean {
  const key = lens.trim().toLowerCase();
  if (key === 'all memories') {
    return true;
  }
  if (key === 'identity') {
    return memory.category.toLowerCase() === 'identity';
  }
  const blob = `${memory.fact} ${memory.tags.join(' ')} ${memory.category}`.toLowerCase();
  if (key === 'interaction history') {
    return /group|chat|conversation|message|whatsapp|interaction|social|thread/.test(blob);
  }
  if (key === 'style notes') {
    return (
      memory.category.toLowerCase() === 'preference' ||
      /style|voice|tone|manner|habit|phrasing/.test(blob)
    );
  }
  return true;
}

const PARTICIPATION_EVENT_HINT = /participat|group|ambient|intervention|follow-up|followup|unsolicited/i;

export function filterParticipationLearningEvents(events: OvernightEvent[]): OvernightEvent[] {
  return events.filter((e) => {
    if (PARTICIPATION_EVENT_HINT.test(e.phase) || PARTICIPATION_EVENT_HINT.test(e.reason)) {
      return true;
    }
    return (
      e.inputs.some((line) => PARTICIPATION_EVENT_HINT.test(line)) ||
      e.outputs.some((line) => PARTICIPATION_EVENT_HINT.test(line))
    );
  });
}
