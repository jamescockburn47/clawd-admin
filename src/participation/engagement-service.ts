/// <reference types="node" />
import {
  MAX_FOLLOW_UP_TURNS_PER_WINDOW,
  PARTICIPATION_DEFAULTS,
} from './constants.js';
import {
  closeFollowUpWindow,
  getConversationState,
  incrementFollowUpTurn,
} from './conversation-state.js';

/** Whether the chat may continue an open follow-up (bounded window + signal).
 *  maxFollowUpTurns allows runtime override of the hard cap (defaults to MAX_FOLLOW_UP_TURNS_PER_WINDOW). */
export function shouldContinueFollowUp(input: {
  chatJid: string;
  now: number;
  directlyRepliesToClint: boolean;
  mentionsClint: boolean;
  senderJid?: string | null;
  maxFollowUpTurns?: number;
}): boolean {
  const current = getConversationState(input.chatJid);
  const window = current.followUpWindow;
  if (!window?.open) return false;
  if (input.now > window.expiresAt) {
    closeFollowUpWindow(input.chatJid);
    return false;
  }
  const turnCap = input.maxFollowUpTurns ?? MAX_FOLLOW_UP_TURNS_PER_WINDOW;
  if (window.turnIndex >= turnCap) {
    closeFollowUpWindow(input.chatJid);
    return false;
  }
  if (input.directlyRepliesToClint || input.mentionsClint) return true;
  // Spec §7.6: within an open follow-up window, the same human that Clint just
  // replied to may continue conversationally without tagging or native-reply.
  // This is the bounded "not one-shot" path. Other participants still need an
  // explicit signal to pull Clint in.
  if (
    input.senderJid &&
    window.lastRepliedSenderJid &&
    input.senderJid === window.lastRepliedSenderJid
  ) {
    return true;
  }
  return false;
}

/** Public façade for follow-up turn registration; callers should use this, not conversation-state. */
export function registerFollowUpTurn(chatJid: string): void {
  incrementFollowUpTurn(chatJid);
}

export function getDefaultFollowUpWindowMs(): number {
  return PARTICIPATION_DEFAULTS.followUpWindowMs;
}
