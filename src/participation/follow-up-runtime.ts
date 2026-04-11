/// <reference types="node" />
import { getConversationState } from './conversation-state.js';
import { registerFollowUpTurn, shouldContinueFollowUp } from './engagement-service.js';

export interface FollowUpRuntimeInput {
  chatJid: string;
  isGroup: boolean;
  isFromMe: boolean;
  now: number;
  directlyRepliesToClint: boolean;
  mentionsClint: boolean;
}

export interface FollowUpRuntimeResult {
  inFollowUpExchange: boolean;
  followUpWindowOpen: boolean;
  followUpTurnIndex: number | null;
}

function snapshotFollowUpState(
  chatJid: string,
  inFollowUpExchange: boolean,
): FollowUpRuntimeResult {
  const followUpWindow = getConversationState(chatJid).followUpWindow;
  return {
    inFollowUpExchange,
    followUpWindowOpen: !!followUpWindow?.open,
    followUpTurnIndex: followUpWindow?.turnIndex ?? null,
  };
}

/** Applies real inbound follow-up-turn counting and returns fresh state for logging. */
export function applyProductionFollowUpTurn(
  input: FollowUpRuntimeInput,
): FollowUpRuntimeResult {
  if (!input.isGroup || input.isFromMe) {
    return snapshotFollowUpState(input.chatJid, false);
  }

  const inFollowUpExchange = shouldContinueFollowUp({
    chatJid: input.chatJid,
    now: input.now,
    directlyRepliesToClint: input.directlyRepliesToClint,
    mentionsClint: input.mentionsClint,
  });

  if (inFollowUpExchange) {
    registerFollowUpTurn(input.chatJid);
  }

  return snapshotFollowUpState(input.chatJid, inFollowUpExchange);
}
