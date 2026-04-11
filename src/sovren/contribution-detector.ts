/// <reference types="node" />
import { findContributor, learnContributorJid } from './contributor-registry.js';
import type { ContributorIdentity } from './types.js';

/**
 * Decide whether an incoming WhatsApp message belongs in the SOVREN
 * contribution store.
 *
 * The detection rule is deliberately permissive: any of the following is
 * sufficient.
 *
 * (a) The chat is the SOVREN group (per `SOVREN_GROUP_JID`), AND the sender is
 *     a registered contributor.
 * (b) The sender is a registered contributor, AND the message text or filename
 *     mentions "sovren" (case-insensitive).
 * (c) The sender is a registered contributor, AND the chat is a DM (1:1) to
 *     Clint, AND the filename or message text mentions "sovren".
 *
 * Spec: §6.5 of the SOVREN ingest design.
 */

/** WhatsApp group JID for SOVREN. Hardcoded — group is unique and stable. */
const SOVREN_GROUP_JID = '120363425230153097@g.us';

export interface ContributionDetectionInput {
  chatJid: string;
  isGroup: boolean;
  senderJid: string | null;
  senderName: string | null;
  text: string;
  fileName: string | null;
}

export interface ContributionDetectionResult {
  isContribution: boolean;
  contributor: ContributorIdentity | null;
  reason:
    | 'sovren_group_registered_contributor'
    | 'registered_contributor_sovren_keyword'
    | 'not_a_contribution';
}

const SOVREN_KEYWORD = /\bsovren\b/i;

/** Returns the configured SOVREN group JID. */
export function getSovrenGroupJid(): string {
  return SOVREN_GROUP_JID;
}

/** Detection entry point. Side effect: learns contributor JIDs by name. */
export function detectContribution(
  input: ContributionDetectionInput,
): ContributionDetectionResult {
  // Side effect: opportunistically associate contributor name -> JID.
  learnContributorJid(input.senderJid, input.senderName);

  const contributor = findContributor(input.senderJid, input.senderName);
  if (!contributor) {
    return { isContribution: false, contributor: null, reason: 'not_a_contribution' };
  }

  if (input.isGroup && input.chatJid === SOVREN_GROUP_JID) {
    return {
      isContribution: true,
      contributor,
      reason: 'sovren_group_registered_contributor',
    };
  }

  const haystack = `${input.text}\n${input.fileName ?? ''}`;
  if (SOVREN_KEYWORD.test(haystack)) {
    return {
      isContribution: true,
      contributor,
      reason: 'registered_contributor_sovren_keyword',
    };
  }

  return { isContribution: false, contributor, reason: 'not_a_contribution' };
}
