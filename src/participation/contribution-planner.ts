import type { ParticipationPosture } from './types.js';

/** Single-turn participation move chosen from signals (no I/O). */
export interface ContributionPlan {
  shouldSpeak: boolean;
  role:
    | 'silence'
    | 'answer'
    | 'memory_recall'
    | 'research_injection'
    | 'synthesis'
    | 'correction'
    | 'challenge'
    | 'decision_capture'
    | 'action_framing';
  reason: string;
}

/**
 * Chooses one best move for an ambient group turn from posture and lightweight signals.
 * Pure: callers supply flags from upstream classification.
 */
export function planContribution(input: {
  posture: ParticipationPosture;
  inFollowUpExchange: boolean;
  directlyRepliesToClint: boolean;
  hasQuestion: boolean;
  hasResearchGap: boolean;
  hasDecisionSignal: boolean;
  hasMemorySignal: boolean;
  casualChatter?: boolean;
}): ContributionPlan {
  if (input.inFollowUpExchange && input.directlyRepliesToClint) {
    return { shouldSpeak: true, role: 'answer', reason: 'follow_up_continuation' };
  }

  if (input.casualChatter) {
    return { shouldSpeak: false, role: 'silence', reason: 'casual_chatter' };
  }

  if (input.hasResearchGap) {
    return { shouldSpeak: true, role: 'research_injection', reason: 'research_gap' };
  }

  if (input.hasDecisionSignal) {
    return { shouldSpeak: true, role: 'decision_capture', reason: 'decision_signal' };
  }

  if (input.hasMemorySignal) {
    return { shouldSpeak: true, role: 'memory_recall', reason: 'memory_signal' };
  }

  return { shouldSpeak: false, role: 'silence', reason: 'no_high_value_move' };
}
