/// <reference types="node" />
import { MAX_ROLLING_TURNS_PER_CHAT } from './constants.js';
import type { ReplyTarget } from './types.js';

export interface TurnRecord {
  senderName: string;
  text: string;
  messageId: string | null;
  timestamp: number;
  isBot: boolean;
}

export interface FollowUpWindow {
  open: boolean;
  sourceMessageId: string;
  replyTarget: ReplyTarget | null;
  /** JID of the human Clint was replying to. Used so same-sender continuations count as follow-ups even without @mention or native WhatsApp reply. */
  lastRepliedSenderJid: string | null;
  expiresAt: number;
  /** Count of follow-up exchanges recorded while the window stays open (starts at 0). */
  turnIndex: number;
}

export interface ConversationState {
  turns: TurnRecord[];
  followUpWindow: FollowUpWindow | null;
}

function emptyState(): ConversationState {
  return { turns: [], followUpWindow: null };
}

function cloneConversationState(state: ConversationState): ConversationState {
  return {
    turns: state.turns.map((turn) => ({ ...turn })),
    followUpWindow: state.followUpWindow ? { ...state.followUpWindow } : null,
  };
}

class ConversationStateService {
  private readonly byChat = new Map<string, ConversationState>();

  private getOrCreate(chatJid: string): ConversationState {
    let state = this.byChat.get(chatJid);
    if (!state) {
      state = emptyState();
      this.byChat.set(chatJid, state);
    }
    return state;
  }

  private trimRollingTurns(turns: TurnRecord[]): void {
    while (turns.length > MAX_ROLLING_TURNS_PER_CHAT) {
      turns.shift();
    }
  }

  recordParticipantTurn(
    turn: TurnRecord & {
      chatJid: string;
    },
  ): void {
    const state = this.getOrCreate(turn.chatJid);
    const { chatJid: _jid, ...record } = turn;
    state.turns.push(record);
    this.trimRollingTurns(state.turns);
  }

  openFollowUpWindow(input: {
    chatJid: string;
    sourceMessageId: string;
    replyTarget: ReplyTarget | null;
    lastRepliedSenderJid?: string | null;
    expiresAt: number;
  }): void {
    const state = this.getOrCreate(input.chatJid);
    state.followUpWindow = {
      open: true,
      sourceMessageId: input.sourceMessageId,
      replyTarget: input.replyTarget,
      lastRepliedSenderJid: input.lastRepliedSenderJid ?? null,
      expiresAt: input.expiresAt,
      turnIndex: 0,
    };
  }

  closeFollowUpWindow(chatJid: string): void {
    const state = this.byChat.get(chatJid);
    if (!state?.followUpWindow) return;
    state.followUpWindow = null;
  }

  incrementFollowUpTurn(chatJid: string): void {
    const window = this.byChat.get(chatJid)?.followUpWindow;
    if (!window?.open) return;
    window.turnIndex += 1;
  }

  getConversationState(chatJid: string): ConversationState {
    const state = this.byChat.get(chatJid);
    return cloneConversationState(state ?? emptyState());
  }

  clearConversationStateForTest(): void {
    this.byChat.clear();
  }
}

const activeConversationStateService = new ConversationStateService();

/** Appends a turn and trims the rolling buffer for the chat. */
export function recordParticipantTurn(
  turn: TurnRecord & {
    chatJid: string;
  },
): void {
  activeConversationStateService.recordParticipantTurn(turn);
}

/** Opens a bounded follow-up window anchored on a bot message. */
export function openFollowUpWindow(input: {
  chatJid: string;
  sourceMessageId: string;
  replyTarget: ReplyTarget | null;
  lastRepliedSenderJid?: string | null;
  expiresAt: number;
}): void {
  activeConversationStateService.openFollowUpWindow(input);
}

/** Low-level helper for engagement orchestration; most callers should use engagement-service. */
export function closeFollowUpWindow(chatJid: string): void {
  activeConversationStateService.closeFollowUpWindow(chatJid);
}

/** Internal state helper; external callers should prefer engagement-service.registerFollowUpTurn. */
export function incrementFollowUpTurn(chatJid: string): void {
  activeConversationStateService.incrementFollowUpTurn(chatJid);
}

/** Returns a detached snapshot; unknown chats get an empty shape, not a live mutable entry. */
export function getConversationState(chatJid: string): ConversationState {
  return activeConversationStateService.getConversationState(chatJid);
}

/** Clears all in-memory conversation state (tests only). */
export function clearConversationStateForTest(): void {
  activeConversationStateService.clearConversationStateForTest();
}
