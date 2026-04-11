export const DEFAULT_AMBIENT_AGENCY_POLICY = Object.freeze({
  enabled: true,
  policyName: 'lqcore-default',
  minHeuristicScore: 4,
  minModelConfidence: 0.78,
  cooldownMs: 180000,
  maxInterventionsPerHour: 6,
});

const DISABLED_POLICY = Object.freeze({
  enabled: false,
  policyName: 'disabled',
  minHeuristicScore: DEFAULT_AMBIENT_AGENCY_POLICY.minHeuristicScore,
  minModelConfidence: DEFAULT_AMBIENT_AGENCY_POLICY.minModelConfidence,
  cooldownMs: DEFAULT_AMBIENT_AGENCY_POLICY.cooldownMs,
  maxInterventionsPerHour: DEFAULT_AMBIENT_AGENCY_POLICY.maxInterventionsPerHour,
});

const LQCORE_LABELS = new Set(['lqcore', 'lq core']);
const SOVREN_LABELS = new Set(['sovren']);
const SOVREN_AMBIENT_POLICY = Object.freeze({
  enabled: true,
  policyName: 'sovren-default',
  minHeuristicScore: 2,
  minModelConfidence: 0.65,
  cooldownMs: 120000,
  maxInterventionsPerHour: 14,
});

export function getAmbientAgencyConfig(opts) {
  const label = (opts.groupLabel || '').trim().toLowerCase();
  if (LQCORE_LABELS.has(label)) {
    return DEFAULT_AMBIENT_AGENCY_POLICY;
  }
  if (SOVREN_LABELS.has(label)) {
    return SOVREN_AMBIENT_POLICY;
  }
  return DISABLED_POLICY;
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
