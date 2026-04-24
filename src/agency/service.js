import logger from '../logger.js';
import { getGroupConfig, getGroupLabel, getGroupMode } from '../group-registry.js';
import { getRecentGroupMessages, formatTranscript } from '../topic-scan.js';
import { getClawdResponseResult } from '../claude.js';
import { filterResponse, getBlockedResponse } from '../output-filter.js';
import { logConversation } from '../memory.js';
import { pushMessage } from '../buffer.js';
import { broadcastSSE } from '../sse.js';
import { isInCooldown, isMuted, recordGroupResponse } from '../engagement.js';
import { cacheSentMessage } from '../message-cache.js';
import { logInteraction } from '../interaction-log.js';
import { openFollowUpWindow, getConversationState } from '../participation/conversation-state.js';
import { shouldContinueFollowUp } from '../participation/engagement-service.js';
import { appendParticipationDecision } from '../participation/log-store.js';
import { getParticipationProfile } from '../participation/policy-service.js';
import { planContribution } from '../participation/contribution-planner.js';
import {
  detectAlreadyAnswered,
  getAmbientAgencyConfig,
  isAmbientAgencyEligible,
  scoreAmbientOpportunity,
} from './policy.js';
import { prefilterAmbientOpportunity } from './model.js';
import { logAgencyDecision } from './log.js';

const interventionHistory = new Map();
const DEFAULT_GROUP_LABEL = 'unknown';
/** Reject messages older than this (seconds). Prevents responding to stale questions on reconnect. */
const MAX_MESSAGE_AGE_S = 90;
const SIGNALS = Object.freeze({
  question: 'question',
  researchGap: 'research_gap',
  actionItems: 'action_items',
  synthesisNeeded: 'synthesis_needed',
  casualChatter: 'casual_chatter',
});

function pruneHistory(groupJid, now) {
  const recent = (interventionHistory.get(groupJid) || []).filter(
    (ts) => now - ts < 60 * 60 * 1000,
  );
  interventionHistory.set(groupJid, recent);
  return recent;
}

function inHourLimit(groupJid, now, policy) {
  const recent = pruneHistory(groupJid, now);
  return recent.length >= policy.maxInterventionsPerHour;
}

function inAmbientCooldown(groupJid, now, policy) {
  const recent = pruneHistory(groupJid, now);
  return recent.some((ts) => now - ts < policy.cooldownMs);
}

function noteIntervention(groupJid, now) {
  const recent = pruneHistory(groupJid, now);
  recent.push(now);
  interventionHistory.set(groupJid, recent);
}

// buildAmbientPrompt removed 2026-04-24 — the 27B now gets the same
// system prompt as a direct-mention response (via getSystemPrompt in
// prompt.js) with a small "ambient participation protocol" suffix
// appended by claude.js when options.ambient=true. No separate
// shortened prompt, no separate call path.

function includesSignal(signals, signal) {
  return signals.includes(signal);
}

function getParticipationContext(chatJid, replyTarget, profilePosture) {
  const followUpWindow = getConversationState(chatJid).followUpWindow;
  return {
    replyTarget: replyTarget ?? null,
    followUpWindowOpen: !!followUpWindow?.open,
    followUpTurnIndex: followUpWindow?.turnIndex ?? null,
    profilePosture,
  };
}

function logParticipationDecision(input) {
  appendParticipationDecision({
    chatJid: input.chatJid,
    shouldIntervene: input.finalDecision.shouldIntervene,
    interventionType: input.finalDecision.interventionType,
    reason: input.finalDecision.reason,
    confidence: input.finalDecision.confidence,
    replyTarget: input.replyTarget,
    followUpWindowOpen: input.followUpWindowOpen,
    followUpTurnIndex: input.followUpTurnIndex,
    profilePosture: input.profilePosture,
    plannedRole: input.plannedRole,
  });
}

function rejectAmbientDecision(input) {
  const finalDecision = {
    shouldIntervene: false,
    reason: input.reason,
    interventionType: null,
    confidence: input.confidence ?? 0,
  };
  logParticipationDecision({
    chatJid: input.chatJid,
    finalDecision,
    ...input.participationContext,
    plannedRole: input.plannedRole ?? null,
  });
  logAgencyDecision({
    chatJid: input.chatJid,
    groupLabel: input.groupLabel,
    senderName: input.senderName,
    text: input.text.slice(0, 300),
    heuristic: input.heuristic,
    participationProfile: input.profile,
    participationContext: input.participationContext,
    participationPlan: input.participationPlan,
    finalDecision: { shouldIntervene: false, reason: input.reason },
  });
  return false;
}

export async function maybeRunAmbientAgency(opts) {
  if (!opts.text) return false;

  const groupLabel = getGroupLabel(opts.chatJid) || DEFAULT_GROUP_LABEL;
  const groupConfig = getGroupConfig(opts.chatJid);
  const groupMode = getGroupMode(opts.chatJid);
  const profile = getParticipationProfile({
    chatJid: opts.chatJid,
    groupLabel,
    groupMode,
  });
  const now = Date.now();
  const policy = getAmbientAgencyConfig({ groupLabel });
  const inFollowUpExchange = shouldContinueFollowUp({
    chatJid: opts.chatJid,
    now,
    directlyRepliesToClint: !!opts.directlyRepliesToClint,
    mentionsClint: !!opts.mentionsClint,
    maxFollowUpTurns: policy.maxFollowUpTurns,
  });
  const eligibleVerdict = isAmbientAgencyEligible({
    isGroup: true,
    triggerRespond: opts.triggerRespond,
    text: opts.text,
    groupLabel,
    groupMode,
    policy,
  });
  const participationContext = getParticipationContext(
    opts.chatJid,
    opts.replyTarget,
    profile.posture,
  );

  if (!eligibleVerdict.eligible) {
    return rejectAmbientDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text,
      reason: eligibleVerdict.reason,
      profile,
      participationContext,
      plannedRole: null,
    });
  }

  // Message staleness guard — reject messages older than MAX_MESSAGE_AGE_S.
  // Baileys messageTimestamp is Unix epoch in seconds.
  if (opts.messageTimestamp) {
    const msgEpochMs = typeof opts.messageTimestamp === 'number'
      ? (opts.messageTimestamp < 1e12 ? opts.messageTimestamp * 1000 : opts.messageTimestamp)
      : 0;
    if (msgEpochMs > 0 && now - msgEpochMs > MAX_MESSAGE_AGE_S * 1000) {
      return rejectAmbientDecision({
        chatJid: opts.chatJid,
        groupLabel,
        senderName: opts.senderName,
        text: opts.text,
        reason: 'message_too_old',
        profile,
        participationContext,
        plannedRole: null,
      });
    }
  }

  if (inHourLimit(opts.chatJid, now, policy)) {
    return rejectAmbientDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text,
      reason: 'hourly_limit',
      profile,
      participationContext,
      plannedRole: null,
    });
  }

  const transcriptMessages = getRecentGroupMessages(opts.chatJid, 25);
  const transcript = formatTranscript(transcriptMessages);

  // Duplicate/self-repeat guard: penalise if a human or Clint already answered.
  const alreadyAnswered = detectAlreadyAnswered(transcriptMessages, opts.text);
  if (alreadyAnswered.reason === 'clint_already_answered') {
    return rejectAmbientDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text,
      reason: 'clint_already_answered',
      profile,
      participationContext,
      plannedRole: null,
    });
  }

  const heuristic = scoreAmbientOpportunity({
    text: opts.text,
    recentTranscript: transcript,
  });
  // Apply already-answered penalty (human replied = -3) to heuristic score
  if (alreadyAnswered.penalty > 0) {
    heuristic.total = Math.max(0, heuristic.total - alreadyAnswered.penalty);
    heuristic.signals.push(alreadyAnswered.reason);
  }
  const contributionPlan = planContribution({
    posture: profile.posture,
    inFollowUpExchange,
    directlyRepliesToClint: !!opts.directlyRepliesToClint,
    hasQuestion: includesSignal(heuristic.signals, SIGNALS.question),
    hasResearchGap: includesSignal(heuristic.signals, SIGNALS.researchGap),
    hasDecisionSignal:
      includesSignal(heuristic.signals, SIGNALS.actionItems)
      || includesSignal(heuristic.signals, SIGNALS.synthesisNeeded),
    hasMemorySignal: false,
    casualChatter: includesSignal(heuristic.signals, SIGNALS.casualChatter),
  });
  const cooldownActive = isInCooldown(opts.chatJid)
    || isMuted(opts.chatJid)
    || inAmbientCooldown(opts.chatJid, now, policy);

  if (cooldownActive) {
    return rejectAmbientDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text,
      reason: 'cooldown',
      heuristic,
      profile,
      participationContext,
      participationPlan: contributionPlan,
      plannedRole: contributionPlan.role,
    });
  }

  // 2026-04-24 redesign: the heuristic threshold gate is GONE. It was
  // rejecting every LQCore message at score 2-3, and the downstream 4B
  // classifier was rejecting the rest with confidence 0.00. Replaced
  // with a simple binary 4B pre-filter + single-call 27B decision.
  //
  // The heuristic signals are still computed (above) for telemetry —
  // useful for post-hoc "what did we nearly miss?" analysis — but no
  // longer block the pipeline.
  const prefilter = await prefilterAmbientOpportunity({
    text: opts.text,
    transcript,
    groupLabel,
  });
  const decisionParticipationContext = getParticipationContext(
    opts.chatJid,
    opts.replyTarget,
    profile.posture,
  );

  if (!prefilter.worth) {
    logAgencyDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text.slice(0, 300),
      groupConfig,
      heuristic,
      prefilter,
      participationProfile: profile,
      participationContext: { ...decisionParticipationContext, inFollowUpExchange },
      participationPlan: contributionPlan,
      finalDecision: { shouldIntervene: false, reason: 'prefilter_no' },
    });
    return false;
  }

  // Pre-lock the cooldown BEFORE the 27B call to prevent race conditions
  // where two fast messages both pass the cooldown check before either finishes.
  noteIntervention(opts.chatJid, Date.now());

  // One call: the 27B decides speak-or-silent AND composes the response
  // in a single pass. Uses the full claude.js pipeline (cortex, memory,
  // tools, group identity) — the exact same plumbing as a direct @mention,
  // differing only in the `ambient: true` flag that injects the SILENT
  // opt-out protocol into the system prompt.
  const responseResult = await getClawdResponseResult(
    opts.text,
    'direct',
    opts.senderJid,
    null,                      // no image
    opts.chatJid,
    { ambient: true },
  );
  const rawResponse = responseResult?.text ?? null;

  logAgencyDecision({
    chatJid: opts.chatJid,
    groupLabel,
    senderName: opts.senderName,
    text: opts.text.slice(0, 300),
    groupConfig,
    heuristic,
    prefilter,
    participationProfile: profile,
    participationContext: { ...decisionParticipationContext, inFollowUpExchange },
    participationPlan: contributionPlan,
    finalDecision: {
      shouldIntervene: !!rawResponse,
      reason: rawResponse ? 'speak' : (responseResult?.meta?.providerReason || 'no_response'),
      providerReason: responseResult?.meta?.providerReason || null,
    },
  });

  if (!rawResponse?.trim()) {
    // 27B chose SILENT or produced no output — respect that signal.
    // The pre-locked cooldown persists: if the 27B doesn't speak this
    // time, we still pause before the next attempt to avoid burning
    // rate-limit on a topic it already declined.
    return false;
  }

  const filterResult = filterResponse(rawResponse, opts.chatJid);
  const finalResponse = filterResult.safe ? rawResponse : getBlockedResponse(filterResult.reason);

  try {
    logConversation(opts.chatJid, [{ senderName: 'Clint', text: finalResponse, isBot: true }]);
  } catch (err) {
    logger.warn({ err: err.message }, 'ambient agency conversation log failed');
  }

  const sent = await opts.sock.sendMessage(opts.chatJid, { text: finalResponse });
  if (sent?.key?.id) {
    cacheSentMessage(sent.key.id, sent.message);
    // Only open a new follow-up window if one isn't already active.
    // Re-opening resets turnIndex to 0, defeating the 3-turn cap.
    const existingWindow = getConversationState(opts.chatJid).followUpWindow;
    if (!existingWindow?.open) {
      openFollowUpWindow({
        chatJid: opts.chatJid,
        sourceMessageId: sent.key.id,
        replyTarget: opts.replyTarget ?? null,
        lastRepliedSenderJid: opts.senderJid || null,
        expiresAt: Date.now() + profile.followUpWindowMs,
      });
    }
  }
  const postSendParticipationContext = getParticipationContext(
    opts.chatJid,
    opts.replyTarget,
    profile.posture,
  );
  pushMessage(opts.chatJid, {
    senderName: 'Clint',
    text: finalResponse,
    hasImage: false,
    isBot: true,
  });
  const responseMeta = responseResult?.meta || {};
  broadcastSSE('message', {
    sender: 'Clint',
    text: finalResponse,
    timestamp: Date.now(),
    chatJid: opts.chatJid,
    isBot: true,
    isGroup: true,
    category: responseMeta.category || null,
    model: 'ambient-27b',
  });
  logInteraction({
    sender: { name: opts.senderName, jid: opts.senderJid },
    source: 'whatsapp',
    input: { text: opts.text, hadImage: false, ambient: true },
    routing: {
      mode: 'ambient',
      category: responseMeta.category || null,
      model: responseMeta.modelName || 'ambient-27b',
      classifySource: responseMeta.classifySource || null,
      routeForceClaude: responseMeta.routeForceClaude || false,
    },
    toolsCalled: [],
    response: { text: finalResponse, chars: finalResponse.length },
    participation: {
      plannedRole: contributionPlan.role,
      inFollowUpExchange,
      ...postSendParticipationContext,
    },
    latencyMs: null,
    messageIds: sent?.key?.id ? [sent.key.id] : [],
  });
  recordGroupResponse(opts.chatJid);
  logger.info({
    chatJid: opts.chatJid,
    groupLabel,
    plannedRole: contributionPlan.role,
    category: responseMeta.category || null,
  }, 'ambient agency intervention sent');
  return true;
}
