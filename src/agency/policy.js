import { getAgencyPolicyOverride } from '../participation/policy-service.js';

/** Hardcoded defaults — runtime overrides from group-participation.json merge on top. */
// 2026-04-24 recalibration: minHeuristicScore 6→3.
// Evidence from data/agency-decisions.jsonl over the 2026-04-20 → 04-24 window:
// every LQCore decision at threshold 6 was rejected as heuristic_below_threshold.
// Typical LQCore messages score 2-3 from a single signal (action_items, question),
// 4+ only on deliberately composed posts. Threshold 6 required 2-3 strong signals
// per message — a bar real chat rarely clears. That matched the "stop over-
// participating" concern from d39b80b but over-corrected into silent. Threshold
// 3 matches the SOVREN default and lets real signal through while still
// requiring AT LEAST one substantive heuristic hit; second-stage model judge
// (minModelConfidence 0.85) is a separate gate that catches the remaining noise.
const DEFAULT_LQCORE_POLICY = {
  enabled: true,
  policyName: 'lqcore-default',
  minHeuristicScore: 3,
  minModelConfidence: 0.85,
  cooldownMs: 300000,
  maxInterventionsPerHour: 3,
  maxFollowUpTurns: 3,
};

const DISABLED_POLICY = Object.freeze({
  enabled: false,
  policyName: 'disabled',
  minHeuristicScore: DEFAULT_LQCORE_POLICY.minHeuristicScore,
  minModelConfidence: DEFAULT_LQCORE_POLICY.minModelConfidence,
  cooldownMs: DEFAULT_LQCORE_POLICY.cooldownMs,
  maxInterventionsPerHour: DEFAULT_LQCORE_POLICY.maxInterventionsPerHour,
  maxFollowUpTurns: DEFAULT_LQCORE_POLICY.maxFollowUpTurns,
});

const LQCORE_LABELS = new Set(['lqcore', 'lq core']);
const SOVREN_LABELS = new Set(['sovren']);
const DEFAULT_SOVREN_POLICY = {
  enabled: true,
  policyName: 'sovren-default',
  minHeuristicScore: 2,
  minModelConfidence: 0.65,
  cooldownMs: 120000,
  maxInterventionsPerHour: 14,
  maxFollowUpTurns: 3,
};

/** Exported for the console GET /api/participation/config endpoint. */
export const AGENCY_DEFAULTS = Object.freeze({
  lqcore: { ...DEFAULT_LQCORE_POLICY },
  sovren: { ...DEFAULT_SOVREN_POLICY },
});

/**
 * Returns the resolved agency policy for a group label, merging hardcoded
 * defaults with any runtime overrides from the persisted store.
 * Reads fresh from disk on every call — no restart needed.
 */
export function getAmbientAgencyConfig(opts) {
  const label = (opts.groupLabel || '').trim().toLowerCase();
  let base;
  if (LQCORE_LABELS.has(label)) {
    base = { ...DEFAULT_LQCORE_POLICY };
  } else if (SOVREN_LABELS.has(label)) {
    base = { ...DEFAULT_SOVREN_POLICY };
  } else {
    return DISABLED_POLICY;
  }

  // Merge runtime overrides from persisted store
  const override = getAgencyPolicyOverride(label);
  if (override) {
    if (typeof override.enabled === 'boolean') base.enabled = override.enabled;
    if (typeof override.minHeuristicScore === 'number') base.minHeuristicScore = override.minHeuristicScore;
    if (typeof override.minModelConfidence === 'number') base.minModelConfidence = override.minModelConfidence;
    if (typeof override.cooldownMs === 'number') base.cooldownMs = override.cooldownMs;
    if (typeof override.maxInterventionsPerHour === 'number') base.maxInterventionsPerHour = override.maxInterventionsPerHour;
    if (typeof override.maxFollowUpTurns === 'number') base.maxFollowUpTurns = override.maxFollowUpTurns;
  }
  return base;
}

export function isAmbientAgencyEligible(input) {
  if (!input.isGroup) return { eligible: false, reason: 'not_group' };
  if (input.triggerRespond) return { eligible: false, reason: 'already_addressed' };
  if (!input.policy.enabled) return { eligible: false, reason: 'policy_disabled' };
  if (!input.text || input.text.trim().length < 12) return { eligible: false, reason: 'low_signal' };
  const mode = input.groupMode || 'colleague';
  const label = (input.groupLabel || '').trim().toLowerCase();
  if (mode !== 'open' && !(mode === 'project' && SOVREN_LABELS.has(label))) {
    return { eligible: false, reason: 'group_mode_blocked' };
  }
  return { eligible: true, reason: 'eligible' };
}

const SIGNAL_PATTERNS = [
  { signal: 'project_topic', weight: 3, pattern: /\b(sovren|sovereign award valuation engine|slaney methodology|valuation engine)\b/i },
  { signal: 'architecture_request', weight: 2, pattern: /\b(architecture|how you work|how do you work|system|stack|tools|what do you know|explain)\b/i },
  { signal: 'direct_bot_address', weight: 2, pattern: /^(hi|hello|hey)\s+clint\b|\bclint\b/i },
  { signal: 'legal_topic', weight: 2, pattern: /\b(authority|judgment|court|costs|disclosure|relief|claim|application|order|evidence|bundle|solicitor|counsel|tribunal|procedure)\b/i },
  { signal: 'uncertainty', weight: 2, pattern: /\b(not sure|unsure|unclear|i think|i doubt|do not think|doesn't seem|not convinced|question is whether)\b/i },
  { signal: 'action_items', weight: 2, pattern: /\b(we should|someone should|follow up|need to|action point|before tomorrow|deadline|owner)\b/i },
  { signal: 'synthesis_needed', weight: 2, pattern: /\b(summarise|summarize|where we landed|what did we decide|position|recap|catch me up)\b/i },
  { signal: 'research_gap', weight: 1, pattern: /\b(latest|recent|current|after the recent changes|does anyone know|any authority)\b/i },
  { signal: 'question', weight: 1, pattern: /\?/i },
];

export function scoreAmbientOpportunity(input) {
  const haystack = `${input.text}\n${input.recentTranscript || ''}`;
  const signals = [];
  let total = 0;

  for (const candidate of SIGNAL_PATTERNS) {
    if (candidate.pattern.test(haystack)) {
      signals.push(candidate.signal);
      total += candidate.weight;
    }
  }

  if (/\b(haha|lol|fair enough|morning all|good morning|sounds good|cheers)\b/i.test(input.text)) {
    total = Math.max(0, total - 3);
    signals.push('casual_chatter');
  }

  return { total, signals };
}

/**
 * Scan the transcript for signs that the triggering message has already been
 * answered — either by a human or by Clint himself.
 * Returns a negative weight to subtract from the heuristic score and a reason
 * string for logging.
 *
 * @param {Array<{sender: string, text: string, isBot: boolean}>} recentMessages
 *   Parsed transcript messages (most recent last).
 * @param {string} triggerText — the message being evaluated for ambient response.
 * @returns {{ penalty: number, reason: string | null }}
 */
export function detectAlreadyAnswered(recentMessages, triggerText) {
  if (!recentMessages?.length || !triggerText) return { penalty: 0, reason: null };

  const triggerNorm = triggerText.trim().toLowerCase().slice(0, 200);
  let triggerIdx = -1;
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i];
    if (!msg.isBot && msg.text?.trim().toLowerCase().slice(0, 200) === triggerNorm) {
      triggerIdx = i;
      break;
    }
  }
  if (triggerIdx === -1) return { penalty: 0, reason: null };

  let humanReplied = false;
  let clintReplied = false;
  for (let i = triggerIdx + 1; i < recentMessages.length; i++) {
    const msg = recentMessages[i];
    if (!msg.text || msg.text.trim().length < 30) continue;
    if (msg.isBot) {
      clintReplied = true;
    } else {
      humanReplied = true;
    }
  }

  if (clintReplied) return { penalty: 5, reason: 'clint_already_answered' };
  if (humanReplied) return { penalty: 3, reason: 'human_already_answered' };
  return { penalty: 0, reason: null };
}

export function finalizeAgencyDecision(input) {
  if (!input.eligibleVerdict.eligible) {
    return {
      shouldIntervene: false,
      reason: input.eligibleVerdict.reason,
      interventionType: null,
      confidence: 0,
      rationale: null,
    };
  }

  if (input.cooldownActive) {
    return {
      shouldIntervene: false,
      reason: 'cooldown',
      interventionType: null,
      confidence: 0,
      rationale: null,
    };
  }

  if (input.heuristicScore < input.policy.minHeuristicScore) {
    return {
      shouldIntervene: false,
      reason: 'heuristic_below_threshold',
      interventionType: null,
      confidence: input.modelVerdict.confidence,
      rationale: input.modelVerdict.rationale,
    };
  }

  if (!input.modelVerdict.intervene || input.modelVerdict.confidence < input.policy.minModelConfidence) {
    return {
      shouldIntervene: false,
      reason: 'model_below_threshold',
      interventionType: null,
      confidence: input.modelVerdict.confidence,
      rationale: input.modelVerdict.rationale,
    };
  }

  return {
    shouldIntervene: true,
    reason: 'approved',
    interventionType: input.modelVerdict.interventionType,
    confidence: input.modelVerdict.confidence,
    rationale: input.modelVerdict.rationale,
  };
}
