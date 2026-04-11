import logger from '../logger.js';
import { getGroupConfig, getGroupLabel, getGroupMode } from '../group-registry.js';
import { getRecentGroupMessages, formatTranscript } from '../topic-scan.js';
import { gatherIntelligence } from '../cortex.js';
import { getGroupModeResponse } from '../claude.js';
import { filterResponse, getBlockedResponse } from '../output-filter.js';
import { logConversation } from '../memory.js';
import { pushMessage, buildContext } from '../buffer.js';
import { broadcastSSE } from '../sse.js';
import { isInCooldown, isMuted, recordGroupResponse } from '../engagement.js';
import { cacheSentMessage } from '../message-cache.js';
import { logInteraction } from '../interaction-log.js';
import {
  finalizeAgencyDecision,
  getAmbientAgencyConfig,
  isAmbientAgencyEligible,
  scoreAmbientOpportunity,
} from './policy.js';
import { classifyAmbientOpportunity } from './model.js';
import { logAgencyDecision } from './log.js';

const interventionHistory = new Map();

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

function buildAmbientPrompt(opts) {
  return `You are Clint, contributing unprompted to a live professional group conversation.

You are speaking because a separate intervention policy already decided your contribution is likely useful.

Rules:
- Be brief, direct, and high-signal.
- Do not say you were "not asked" or mention internal policy.
- No emojis.
- No tool calls or promises to take actions.
- Ground yourself in the conversation and the context provided.
- Prefer one useful intervention over a long answer.
- If the highest-value move is a correction, be precise.
- If the highest-value move is synthesis, compress the discussion.
- If the highest-value move is issue spotting, point to the missing premise or tension.
- If the highest-value move is action-item capture, state the action items and owners succinctly.
- If the highest-value move is a research nudge, point to the question that likely needs checking.

Group: ${opts.groupLabel || 'unknown'}
Intervention type: ${opts.interventionType || 'unspecified'}
Why now: ${opts.rationale || 'useful intervention detected'}

${opts.memoryFragment}

Recent conversation:
${opts.transcript}`;
}

export async function maybeRunAmbientAgency(opts) {
  if (!opts.text) return false;

  const groupLabel = getGroupLabel(opts.chatJid);
  const groupConfig = getGroupConfig(opts.chatJid);
  const policy = getAmbientAgencyConfig({ groupLabel });
  const eligibleVerdict = isAmbientAgencyEligible({
    isGroup: true,
    triggerRespond: opts.triggerRespond,
    text: opts.text,
    groupLabel,
    groupMode: getGroupMode(opts.chatJid),
    policy,
  });

  if (!eligibleVerdict.eligible) {
    logAgencyDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text.slice(0, 300),
      finalDecision: { shouldIntervene: false, reason: eligibleVerdict.reason },
    });
    return false;
  }

  const now = Date.now();
  if (inHourLimit(opts.chatJid, now, policy)) {
    logAgencyDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text.slice(0, 300),
      finalDecision: { shouldIntervene: false, reason: 'hourly_limit' },
    });
    return false;
  }

  const transcriptMessages = getRecentGroupMessages(opts.chatJid, 25);
  const transcript = formatTranscript(transcriptMessages);
  const heuristic = scoreAmbientOpportunity({
    text: opts.text,
    recentTranscript: transcript,
  });
  const cooldownActive = isInCooldown(opts.chatJid)
    || isMuted(opts.chatJid)
    || inAmbientCooldown(opts.chatJid, now, policy);

  if (cooldownActive) {
    logAgencyDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text.slice(0, 300),
      heuristic,
      finalDecision: { shouldIntervene: false, reason: 'cooldown' },
    });
    return false;
  }

  if (heuristic.total < policy.minHeuristicScore) {
    logAgencyDecision({
      chatJid: opts.chatJid,
      groupLabel,
      senderName: opts.senderName,
      text: opts.text.slice(0, 300),
      heuristic,
      finalDecision: { shouldIntervene: false, reason: 'heuristic_below_threshold' },
    });
    return false;
  }

  const modelVerdict = await classifyAmbientOpportunity({
    text: opts.text,
    transcript,
    groupLabel,
  });
  const decision = finalizeAgencyDecision({
    eligibleVerdict,
    heuristicScore: heuristic.total,
    modelVerdict,
    policy,
    cooldownActive: false,
  });

  logAgencyDecision({
    chatJid: opts.chatJid,
    groupLabel,
    senderName: opts.senderName,
    text: opts.text.slice(0, 300),
    groupConfig,
    heuristic,
    modelVerdict,
    finalDecision: decision,
  });

  if (!decision.shouldIntervene) return false;

  const context = buildContext(opts.chatJid, opts.text);
  const { memoryFragment, route } = await gatherIntelligence(context, false, true, {
    disableWebPrefetch: true,
  });
  const systemPrompt = buildAmbientPrompt({
    transcript,
    groupLabel,
    interventionType: decision.interventionType,
    rationale: decision.rationale,
    memoryFragment,
  });
  const rawResponse = await getGroupModeResponse(
    systemPrompt,
    'Write the single most useful unprompted intervention for this group right now.',
    false,
    opts.senderJid,
    opts.chatJid,
  );

  if (!rawResponse?.trim()) return false;

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
  }
  pushMessage(opts.chatJid, {
    senderName: 'Clint',
    text: finalResponse,
    hasImage: false,
    isBot: true,
  });
  broadcastSSE('message', {
    sender: 'Clint',
    text: finalResponse,
    timestamp: Date.now(),
    chatJid: opts.chatJid,
    isBot: true,
    isGroup: true,
    category: route.category,
    model: 'ambient-group',
  });
  logInteraction({
    sender: { name: opts.senderName, jid: opts.senderJid },
    source: 'whatsapp',
    input: { text: opts.text, hadImage: false, ambient: true },
    routing: {
      mode: 'ambient',
      category: route.category,
      model: 'ambient-group',
      classifySource: route.source,
      routeForceClaude: route.forceClaude,
    },
    toolsCalled: [],
    response: { text: finalResponse, chars: finalResponse.length },
    latencyMs: null,
    messageIds: sent?.key?.id ? [sent.key.id] : [],
  });
  recordGroupResponse(opts.chatJid);
  noteIntervention(opts.chatJid, Date.now());
  logger.info({
    chatJid: opts.chatJid,
    groupLabel,
    interventionType: decision.interventionType,
    category: route.category,
  }, 'ambient agency intervention sent');
  return true;
}
