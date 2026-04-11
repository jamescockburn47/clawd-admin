/// <reference types="node" />
import type { ReplyTarget } from './types.js';

/** Builds a quoted-message reply target (e.g. user tapped Reply on a specific message). */
export function quotedReplyTarget(messageId: string, senderName: string): ReplyTarget {
  return { kind: 'quoted', messageId, senderName };
}

/** True when the target references a specific prior message id. */
export function replyTargetReferencesMessage(target: ReplyTarget, messageId: string): boolean {
  return target.kind === 'quoted' && target.messageId === messageId;
}
