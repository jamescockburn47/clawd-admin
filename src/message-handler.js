// src/message-handler.js — WhatsApp incoming message processing
// Extracts text/media, routes through trigger/engagement/classifier, generates responses.

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import config from './config.js';
import logger from './logger.js';
import { shouldRespond } from './trigger.js';
import { pushMessage, buildContext } from './buffer.js';
import { getClawdResponse, getLastToolsCalled, getGroupModeResponse } from './claude.js';
import { broadcastSSE } from './sse.js';
import { logInteraction, handleReaction, isCorrection, logFeedback } from './interaction-log.js';
import { isMuteTrigger, activateMute, isMuted, shouldEngage, detectNegativeSignal, recordGroupResponse, isInCooldown } from './engagement.js';
import { scanMessage } from './lquorum-rag.js';
import { logConversation } from './memory.js';
import { getDocumentInfo, processDocument } from './document-handler.js';
import { handleEvolutionConfirmation, handleEvolutionApproval } from './evolution-gate.js';
import { cacheSentMessage } from './message-cache.js';
import { recordDecryptionFailure } from './session-repair.js';
import { filterResponse, getBlockedResponse } from './output-filter.js';
import { detectGroupMode, detectGroupModeExit, detectTopicSelection, runTopicRetrieval, executeGroupMode, buildExecutionPrompt } from './group-modes.js';
import { clearPendingAction, getPendingAction } from './pending-action.js';

// --- Owner JID resolution ---
const ownerJids = new Set();
if (config.ownerJid) ownerJids.add(config.ownerJid);
if (config.ownerLid) ownerJids.add(config.ownerLid);

export function isOwnerJid(jid) {
  if (!jid || ownerJids.size === 0) return true;
  return ownerJids.has(jid);
}

export function isOwnerChat(chatJid) {
  return ownerJids.has(chatJid);
}

// --- Message text extraction ---

export function extractText(message) {
  const msg = message.message;
  if (!msg) return '';
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || msg.documentWithCaptionMessage?.message?.documentMessage?.caption
    || '';
}

// --- Message splitting and typing simulation ---

const MAX_MESSAGE_LENGTH = 3000;

export function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) splitIdx = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function simulateTyping(sock, chatJid, responseLength) {
  try {
    await sock.presenceSubscribe(chatJid);
    await sock.sendPresenceUpdate('composing', chatJid);
    await new Promise((r) => setTimeout(r, Math.min(500 + responseLength * 10, 4000)));
    await sock.sendPresenceUpdate('paused', chatJid);
  } catch (_) {}
}

// --- Dedup guard ---

const recentMessageIds = new Set();
const DEDUP_MAX = 200;

function isDuplicate(msgId) {
  if (!msgId) return false;
  if (recentMessageIds.has(msgId)) return true;
  recentMessageIds.add(msgId);
  if (recentMessageIds.size > DEDUP_MAX) {
    recentMessageIds.delete(recentMessageIds.values().next().value);
  }
  return false;
}

// --- Image/document follow-up caches ---
const lastImageByChat = new Map();
const lastDocByChat = new Map();

// Re-export for index.js wiring
export { handleReaction };

// --- Engagement gate (passive group messages) ---

async function checkEngagementGate(sock, chatJid, senderName, text) {
  const lowerForGate = (text || '').toLowerCase();
  // Self-coding / evolution messages require @mention
  if (/\b(self.?program|self.?cod|evolution|evolve|tweak.*classif|fix.*yourself|upgrade.*yourself|improve.*yourself|recode|reprogram|fix.*classif|change.*code|modify.*code|update.*code)\b/.test(lowerForGate)) {
    logger.debug({ groupJid: chatJid, sender: senderName }, 'self-coding keyword in passive mode — requires @mention');
    return 'block';
  }
  if (isMuteTrigger(text)) {
    activateMute(chatJid);
    try {
      await sock.sendMessage(chatJid, { text: 'Going quiet.' });
      pushMessage(chatJid, { senderName: 'Clawd', text: 'Going quiet.', hasImage: false, isBot: true });
    } catch {}
    return 'muted';
  }
  const negSignal = detectNegativeSignal(text);
  if (negSignal) {
    const ownerJid = config.ownerJid;
    if (ownerJid) {
      const proposal = `Negative reaction in group.\n\n*${negSignal.type}* from ${senderName}: "${text.slice(0, 200)}"\n\nReply with what I should learn from this and I'll propose a soul update. Or ignore to dismiss.`;
      sock.sendMessage(ownerJid, { text: proposal }).catch(() => {});
    }
  }
  if (isMuted(chatJid)) { logger.debug({ groupJid: chatJid }, 'muted — skipping'); return 'block'; }
  if (isInCooldown(chatJid)) { logger.debug({ groupJid: chatJid, sender: senderName }, 'cooldown active'); return 'block'; }
  if (config.engagementClassifierEnabled) {
    const engage = await shouldEngage(chatJid, senderName, text);
    if (!engage) { logger.debug({ groupJid: chatJid, sender: senderName }, 'classifier: silent'); return 'block'; }
    logger.info({ groupJid: chatJid, sender: senderName }, 'classifier: respond');
    return 'pass';
  }
  return 'block'; // Classifier disabled — default silent
}

// --- Image download ---

async function downloadImage(message) {
  try {
    const buffer = await downloadMediaMessage(message, 'buffer', {});
    const mimeType = message.message.imageMessage.mimetype || 'image/jpeg';
    logger.info({ mime: mimeType, bytes: buffer.length }, 'image downloaded');
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  } catch (err) {
    logger.warn({ err: err.message }, 'image download failed');
    return null;
  }
}

// --- Main message handler ---

export async function handleIncomingMessage(sock, message, botJid) {
  try {
    // Detect decryption failures — messageStubType 2 = CIPHERTEXT (failed to decrypt)
    if (message.messageStubType === 2 && message.key?.remoteJid) {
      const failedJid = message.key.participant || message.key.remoteJid;
      logger.warn({ jid: failedJid, msgId: message.key.id }, 'message decryption failed — recording for session repair');
      recordDecryptionFailure(failedJid);
      return;
    }

    const msgId = message.key.id;
    if (isDuplicate(msgId)) { logger.debug({ msgId }, 'duplicate message ignored'); return; }

    const chatJid = message.key.remoteJid;
    const isGroup = chatJid?.endsWith('@g.us');
    const senderJid = message.key.participant || chatJid;
    const senderName = message.pushName || 'Unknown';
    const text = extractText(message);
    const msgHasImage = !!message.message?.imageMessage;
    const docInfo = getDocumentInfo(message);

    logger.info({ sender: senderName, text: text || (msgHasImage ? '[photo]' : docInfo ? `[file: ${docInfo.fileName}]` : '[empty]') }, 'message received');

    if (!text && !msgHasImage && !docInfo) return;

    pushMessage(chatJid, { senderName, text, hasImage: msgHasImage, isBot: false });

    // Evolution gates (owner DM only)
    if (!isGroup && (isOwnerChat(chatJid) || isOwnerJid(senderJid)) && text) {
      if (await handleEvolutionConfirmation(sock, chatJid, text)) return;
      if (await handleEvolutionApproval(sock, chatJid, text)) return;
    }

    if (isGroup && text) scanMessage(text);

    if (isOwnerChat(chatJid) || isOwnerJid(senderJid)) {
      if (text) broadcastSSE('message', { sender: senderName, text, timestamp: Date.now() });
    }

    const repliedToBot = message.message?.extendedTextMessage?.contextInfo?.participant === botJid;
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (isGroup && mentionedJids.length > 0) {
      logger.info({ mentionedJids, botJid, text: (text || '').slice(0, 80) }, 'mention debug');
    }

    const trigger = shouldRespond({ text, hasImage: msgHasImage || !!docInfo, isFromMe: message.key.fromMe, isGroup, senderJid, botJid, groupJid: chatJid, mentionedJids });
    if (!trigger.respond && repliedToBot && !message.key.fromMe) { trigger.respond = true; trigger.mode = 'direct'; trigger.secretaryMode = false; }

    // Log ALL group messages before respond gate (dream mode needs everything)
    if (isGroup && config.evoMemoryEnabled) {
      try { logConversation(chatJid, [{ senderName, text, isBot: false }]); } catch {}
    }

    if (!trigger.respond) return;

    // Engagement gate for passive group messages
    if (trigger.mode === 'passive' && isGroup) {
      const gate = await checkEngagementGate(sock, chatJid, senderName, text);
      if (gate !== 'pass') return;
    }

    // Direct mute trigger
    if (trigger.mode === 'direct' && isGroup && isMuteTrigger(text)) {
      activateMute(chatJid);
      try {
        await sock.sendMessage(chatJid, { text: 'Going quiet.' });
        pushMessage(chatJid, { senderName: 'Clawd', text: 'Going quiet.', hasImage: false, isBot: true });
      } catch {}
      return;
    }

    logger.info({ mode: trigger.mode, chat: chatJid }, 'triggered');

    let messageText = text;
    // Strip @ prefix and bot name prefixes (clawd, clawdbot, clawdsec)
    const BOT_PREFIXES = ['clawdsec', 'clawdbot', 'clawd']; // longest first to avoid partial match
    let lowerMsg = messageText.toLowerCase().replace(/^@/, ''); // strip leading @
    if (lowerMsg !== messageText.toLowerCase()) messageText = messageText.slice(1); // sync actual text
    for (const prefix of BOT_PREFIXES) {
      if (lowerMsg.startsWith(prefix + ' ') || lowerMsg === prefix) {
        messageText = messageText.slice(prefix.length).trim();
        break;
      }
    }
    if (messageText.toLowerCase().startsWith(config.triggerPrefix.toLowerCase())) {
      messageText = messageText.slice(config.triggerPrefix.length).trim();
    }

    // ── GROUP ANALYSIS MODES (devil's advocate, summary) ──────────────────
    if (isGroup) {
      const isExitRequest = detectGroupModeExit(messageText, chatJid);
      if (isExitRequest) {
        logger.info({ chatJid }, 'group analysis mode exit — falling through to normal handling');
        // Pending action already cleared by detectGroupModeExit. Fall through to classifier.
      }

      // Check for pending topic selection (skip if exit requested)
      const topicSel = !isExitRequest && detectTopicSelection(messageText, chatJid);
      if (topicSel) {
        logger.info({ chatJid, mode: topicSel.action.mode, selection: topicSel.selectedTopics }, 'topic selection received');
        await simulateTyping(sock, chatJid, 500);

        const execPrompt = buildExecutionPrompt(topicSel.action, topicSel.selectedTopics);
        const execResponse = await getGroupModeResponse(
          execPrompt, 'Execute the analysis on the selected topics.',
          true, // useOpus — accuracy matters
          senderJid, chatJid
        );

        clearPendingAction(chatJid);
        const finalText = execResponse || 'Failed to complete the analysis. Try again.';

        // Apply output filter
        const filterResult = filterResponse(finalText, chatJid);
        const safeText = filterResult.safe ? finalText : getBlockedResponse(filterResult.reason);

        await simulateTyping(sock, chatJid, safeText.length);
        const chunks = splitMessage(safeText);
        for (const chunk of chunks) {
          const sent = await sock.sendMessage(chatJid, { text: chunk });
          if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
          if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
        }
        pushMessage(chatJid, { senderName: 'Clawd', text: safeText, hasImage: false, isBot: true });
        if (config.evoMemoryEnabled) {
          try { logConversation(chatJid, [{ senderName: 'Clawd', text: safeText, isBot: true }]); } catch {}
        }
        return;
      }

      // Check for new group mode trigger (skip if exit request — "exit devil's advocate" contains the trigger)
      const groupMode = !isExitRequest && detectGroupMode(messageText);
      if (groupMode) {
        logger.info({ chatJid, mode: groupMode.mode }, 'group analysis mode triggered');
        await simulateTyping(sock, chatJid, 200);

        const segResponse = await runTopicRetrieval(chatJid, groupMode.mode);

        // Apply output filter to the topic list too
        const filterResult = filterResponse(segResponse, chatJid);
        const safeText = filterResult.safe ? segResponse : getBlockedResponse(filterResult.reason);

        await simulateTyping(sock, chatJid, safeText.length);
        const sent = await sock.sendMessage(chatJid, { text: safeText });
        if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
        pushMessage(chatJid, { senderName: 'Clawd', text: safeText, hasImage: false, isBot: true });
        if (config.evoMemoryEnabled) {
          try { logConversation(chatJid, [{ senderName: 'Clawd', text: safeText, isBot: true }]); } catch {}
        }
        return;
      }
    }

    // Download image if present
    let imageData = msgHasImage ? await downloadImage(message) : null;

    // Download and process document if present
    if (docInfo && !imageData) {
      try {
        const buffer = await downloadMediaMessage(message, 'buffer', {});
        const result = await processDocument(buffer, docInfo, messageText, senderName, chatJid, lastDocByChat);
        messageText = result.messageText;
      } catch (err) {
        logger.warn({ err: err.message, fileName: docInfo.fileName }, 'document download/parse failed');
      }
    }

    // Detect correction of previous response
    if (isCorrection(messageText)) {
      logFeedback({ interactionId: null, type: 'correction', signal: 'negative', detail: messageText.slice(0, 200), sender: { name: senderName, jid: senderJid } });
    }

    // Image caption defaults
    if (imageData && !messageText.trim()) {
      messageText = '[Photo shared — respond naturally as part of the conversation. React to what you see, relate it to the discussion if relevant. Do not just label or identify objects.]';
    }
    if (imageData) lastImageByChat.set(chatJid, { data: imageData, timestamp: Date.now() });

    // Follow-up image reuse (5 min TTL)
    if (!imageData && /\b(the\s+)?(image|photo|picture|pic|screenshot)\b/i.test(messageText)) {
      const lastImg = lastImageByChat.get(chatJid);
      if (lastImg && (Date.now() - lastImg.timestamp) < 5 * 60 * 1000) {
        imageData = lastImg.data;
        logger.info({ chatJid, ageMs: Date.now() - lastImg.timestamp }, 'reusing recent image for follow-up');
      }
    }

    // Generate response
    const context = buildContext(chatJid, messageText);
    const responseStart = Date.now();
    const response = await getClawdResponse(context, trigger.mode, senderJid, imageData, chatJid, { secretaryMode: !!trigger.secretaryMode });
    const responseLatency = Date.now() - responseStart;
    if (!response || !response.trim() || response.trim() === '[SILENT]') {
      if (response?.trim() === '[SILENT]') logger.debug({ chat: chatJid }, 'Claude chose silence');
      return;
    }

    // Output filter — code-level security, cannot be prompt-injected
    const filterResult = filterResponse(response, chatJid);
    let finalResponse = response;
    if (!filterResult.safe) {
      logger.warn({ chatJid, reason: filterResult.reason, blocked: filterResult.blocked }, 'output filter blocked response');
      finalResponse = getBlockedResponse(filterResult.reason);
    }

    // Send response
    await simulateTyping(sock, chatJid, finalResponse.length);
    const chunks = splitMessage(finalResponse);
    const sentMsgIds = [];
    for (const chunk of chunks) {
      const sent = await sock.sendMessage(chatJid, { text: chunk });
      if (sent?.key?.id) {
        sentMsgIds.push(sent.key.id);
        cacheSentMessage(sent.key.id, sent.message);
      }
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
    }

    pushMessage(chatJid, { senderName: 'Clawd', text: finalResponse, hasImage: false, isBot: true });
    if (isGroup) recordGroupResponse(chatJid);

    if (isOwnerChat(chatJid) || isOwnerJid(senderJid)) {
      broadcastSSE('message', { sender: 'Clawd', text: finalResponse, timestamp: Date.now() });
    }

    logInteraction({
      sender: { name: senderName, jid: senderJid }, source: 'whatsapp',
      input: { text: messageText, hadImage: !!imageData }, routing: { mode: trigger.mode },
      toolsCalled: getLastToolsCalled(), response: { text: finalResponse, chars: finalResponse.length, filtered: !filterResult.safe },
      latencyMs: responseLatency, messageIds: sentMsgIds,
    });

    if (config.evoMemoryEnabled) {
      try { logConversation(chatJid, [{ senderName: 'Clawd', text: finalResponse, isBot: true }]); } catch {}
    }

    logger.info({ mode: trigger.mode, chars: finalResponse.length, filtered: !filterResult.safe, latencyMs: responseLatency }, 'response sent');
  } catch (err) {
    logger.error({ err: err.message }, 'message handler error');
  }
}
