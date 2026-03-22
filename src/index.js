import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createServer } from 'http';
import { execSync, exec } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { shouldRespond } from './trigger.js';
import { pushMessage, buildContext, getRecentMessages, loadBuffers, saveBuffers, flushBufferTimer } from './buffer.js';
import { getClawdResponse, getUsageStats, flushUsage } from './claude.js';
import { getWidgetData, startWidgetRefresh, stopWidgetRefresh, addSSEClient, broadcastSSE, forceRefresh } from './widgets.js';
import { getSoulData, resetSoul } from './tools/soul.js';
import { getAllTodos, getActiveTodos, flushTodos } from './tools/todo.js';
import { todoComplete, todoAdd } from './tools/todo.js';
import { initScheduler } from './scheduler.js';
import { getAuditLog, flushAudit } from './audit.js';
import { checkEvoHealth as checkEvoLlmHealth } from './evo-llm.js';
import { getEvoStatus, getMemoryStats, listMemories, searchMemory, storeNote, updateMemory, deleteMemory, logConversation, checkEvoHealth, getLastHealthData } from './memory.js';
import { seedSystemKnowledge } from './system-knowledge.js';
import { logInteraction, handleReaction, isCorrection, logFeedback, getQualitySummary, getRecentFeedback } from './interaction-log.js';
import { isMuteTrigger, activateMute, isMuted, clearMute, shouldEngage, detectNegativeSignal } from './engagement.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const baileysLogger = pino({ level: 'warn' });

// Track last activity for health status
let lastActivityTimestamp = Date.now();

function printBanner() {
  const banner = `
  CLAWD — Admin Assistant
  Model:    ${config.claudeModel}
  Prefix:   ${config.triggerPrefix}
  Limit:    ${config.dailyCallLimit} calls/day
  Group:    ${config.whatsappGroupJid || '(all groups)'}
  HTTP:     port ${config.httpPort}
  EVO X2:   ${config.evoToolEnabled ? config.evoLlmUrl : 'disabled'}`;
  logger.info(banner);
}

function extractText(message) {
  const msg = message.message;
  if (!msg) return '';
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.imageMessage?.caption
    || msg.videoMessage?.caption
    || msg.documentMessage?.caption
    || '';
}

function hasImageMsg(message) {
  return !!message.message?.imageMessage;
}

function isReplyToBot(message, botJid) {
  const quoted = message.message?.extendedTextMessage?.contextInfo;
  return quoted?.participant === botJid;
}

const MAX_MESSAGE_LENGTH = 3000;

function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function simulateTyping(sock, chatJid, responseLength) {
  try {
    await sock.presenceSubscribe(chatJid);
    await sock.sendPresenceUpdate('composing', chatJid);
    const delay = Math.min(500 + responseLength * 10, 4000);
    await new Promise((r) => setTimeout(r, delay));
    await sock.sendPresenceUpdate('paused', chatJid);
  } catch (_) {}
}

// --- Owner JID resolution ---
const ownerJids = new Set();
if (config.ownerJid) ownerJids.add(config.ownerJid);
if (config.ownerLid) ownerJids.add(config.ownerLid);

function isOwnerJid(jid) {
  if (!jid || ownerJids.size === 0) return true;
  return ownerJids.has(jid);
}

function isOwnerChat(chatJid) {
  return ownerJids.has(chatJid);
}

async function proposeSoulFromReaction(sock, signal, senderName, groupJid, messageText) {
  const ownerJid = config.ownerJid;
  if (!ownerJid) return;

  const proposal = `I noticed a negative reaction in a group chat.\n\n`
    + `*Signal:* ${signal.type} ("${signal.matched}")\n`
    + `*From:* ${senderName}\n`
    + `*Message:* "${messageText.slice(0, 200)}"\n\n`
    + `Should I update my soul to adjust my behaviour? If so, tell me what to change.`;

  try {
    await sock.sendMessage(ownerJid, { text: proposal });
    logger.info({ signal: signal.type, sender: senderName, groupJid }, 'soul proposal DM sent');
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to send soul proposal DM');
  }
}

async function handleMessage(sock, message, botJid) {
  try {
    const chatJid = message.key.remoteJid;
    const isGroup = chatJid?.endsWith('@g.us');
    const senderJid = message.key.participant || chatJid;
    const senderName = message.pushName || 'Unknown';
    const text = extractText(message);
    const msgHasImage = hasImageMsg(message);

    logger.info({ sender: senderName, text: text || (msgHasImage ? '[photo]' : '[empty]') }, 'message received');
    lastActivityTimestamp = Date.now();

    if (!text && !msgHasImage) return;

    pushMessage(chatJid, {
      senderName,
      text,
      hasImage: msgHasImage,
      isBot: false,
    });

    if (isOwnerChat(chatJid) || isOwnerJid(senderJid)) {
      if (text) broadcastSSE('message', { sender: senderName, text, timestamp: Date.now() });
    }

    const repliedToBot = isReplyToBot(message, botJid);
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    const trigger = shouldRespond({
      text,
      hasImage: msgHasImage,
      isFromMe: message.key.fromMe,
      isGroup,
      senderJid,
      botJid,
      groupJid: chatJid,
      mentionedJids,
    });

    if (!trigger.respond && repliedToBot && !message.key.fromMe) {
      trigger.respond = true;
      trigger.mode = 'direct';
    }

    if (!trigger.respond) return;

    // Log ALL group messages to conversation-logs (not just Clawd's exchanges)
    if (isGroup && config.evoMemoryEnabled) {
      try {
        logConversation(chatJid, [
          { senderName, text, isBot: false },
        ]);
      } catch {}
    }

    // --- Engagement gate for group passive messages ---
    if (trigger.mode === 'passive' && isGroup) {
      // Check for mute trigger
      if (isMuteTrigger(text)) {
        activateMute(chatJid);
        try {
          await sock.sendMessage(chatJid, { text: 'Going quiet.' });
          pushMessage(chatJid, { senderName: 'Clawd', text: 'Going quiet.', hasImage: false, isBot: true });
        } catch {}
        return;
      }

      // Detect negative signals → DM James
      const negSignal = detectNegativeSignal(text);
      if (negSignal) {
        proposeSoulFromReaction(sock, negSignal, senderName, chatJid, text).catch(() => {});
      }

      // If muted, stay silent
      if (isMuted(chatJid)) {
        logger.debug({ groupJid: chatJid }, 'muted — skipping passive message');
        return;
      }

      // Engagement classifier decides
      if (config.engagementClassifierEnabled) {
        const engage = await shouldEngage(chatJid, senderName, text);
        if (!engage) {
          logger.debug({ groupJid: chatJid, sender: senderName }, 'classifier: silent');
          return;
        }
        logger.info({ groupJid: chatJid, sender: senderName }, 'classifier: respond');
      } else {
        // Classifier disabled — default silent for passive
        return;
      }
    }

    // Check mute trigger on direct messages too (e.g. "@clawd shut up")
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
    if (messageText.toLowerCase().startsWith(config.triggerPrefix.toLowerCase())) {
      messageText = messageText.slice(config.triggerPrefix.length).trim();
    }

    // Download image if present and bot should respond
    let imageData = null;
    if (msgHasImage) {
      try {
        const buffer = await downloadMediaMessage(message, 'buffer', {});
        const mimeType = message.message.imageMessage.mimetype || 'image/jpeg';
        imageData = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType,
            data: buffer.toString('base64'),
          },
        };
        logger.info({ mime: mimeType, bytes: buffer.length }, 'image downloaded');
      } catch (err) {
        logger.warn({ err: err.message }, 'image download failed');
      }
    }

    // Detect correction of previous response (implicit negative feedback)
    if (isCorrection(messageText)) {
      logFeedback({
        interactionId: null, // can't easily correlate without more state
        type: 'correction',
        signal: 'negative',
        detail: messageText.slice(0, 200),
        sender: { name: senderName, jid: senderJid },
      });
    }

    const context = buildContext(chatJid, messageText);
    const responseStart = Date.now();
    const response = await getClawdResponse(context, trigger.mode, senderJid, imageData, chatJid);
    const responseLatency = Date.now() - responseStart;
    if (!response) return;

    await simulateTyping(sock, chatJid, response.length);

    const chunks = splitMessage(response);
    const sentMsgIds = [];
    for (const chunk of chunks) {
      const sent = await sock.sendMessage(chatJid, { text: chunk });
      if (sent?.key?.id) sentMsgIds.push(sent.key.id);
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
    }

    pushMessage(chatJid, {
      senderName: 'Clawd',
      text: response,
      hasImage: false,
      isBot: true,
    });

    if (isOwnerChat(chatJid) || isOwnerJid(senderJid)) {
      broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });
    }

    // Log full interaction for evolution pipeline
    logInteraction({
      sender: { name: senderName, jid: senderJid },
      source: 'whatsapp',
      input: { text: messageText, hadImage: !!imageData },
      routing: { mode: trigger.mode },
      toolsCalled: [],
      response: { text: response, chars: response.length },
      latencyMs: responseLatency,
      messageIds: sentMsgIds,
    });

    // Log conversation for overnight memory extraction
    if (config.evoMemoryEnabled) {
      try {
        logConversation(chatJid, [
          { senderName: 'Clawd', text: response, isBot: true },
        ]);
      } catch {}
    }

    logger.info({ mode: trigger.mode, chars: response.length, latencyMs: responseLatency }, 'response sent');
  } catch (err) {
    logger.error({ err: err.message }, 'message handler error');
  }
}

// Shared socket reference for the HTTP API
let activeSock = null;

async function sendProactiveMessage(jid, text) {
  if (!activeSock) throw new Error('Socket not connected');
  await simulateTyping(activeSock, jid, text.length);
  await activeSock.sendMessage(jid, { text });
  pushMessage(jid, { senderName: 'Clawd', text, hasImage: false, isBot: true });
  logger.info({ jid, chars: text.length }, 'proactive message sent');
}

async function startBot() {
  printBanner();

  // Load persisted message buffers before connecting
  await loadBuffers();

  const { state, saveCreds } = await useMultiFileAuthState(config.authStatePath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    browser: ['Clawd', 'Chrome', '122.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
  });

  let pairingRequested = false;
  let startupNotified = false;
  let schedulerStarted = false;

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && config.pairingPhoneNumber) {
      if (!pairingRequested) {
        pairingRequested = true;
        logger.info('requesting pairing code...');
        const code = await sock.requestPairingCode(config.pairingPhoneNumber);
        logger.info({ code }, 'pairing code');
      }
    } else if (qr) {
      qrcode.generate(qr, { small: true });
      try {
        writeFileSync('/tmp/qr.txt', qr);
        execSync('qrencode -o /tmp/qr.png -s 10 -m 2 < /tmp/qr.txt');
      } catch (_) {}
    }

    if (connection === 'open') {
      const botJid = sock.user?.id;
      activeSock = sock;
      globalThis._clawdWhatsAppConnected = true;
      logger.info({ name: sock.user?.name, jid: botJid }, 'WhatsApp connected');

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          handleMessage(sock, msg, botJid);
        }
      });

      // Capture message reactions (thumbs up/down) as quality feedback
      sock.ev.on('messages.reaction', (reactions) => {
        for (const { key, reaction } of reactions) {
          if (!reaction?.text || !key?.id) continue;
          const senderJid = key.participant || key.remoteJid;
          logger.info({ emoji: reaction.text, msgId: key.id, sender: senderJid }, 'reaction received');
          handleReaction(key.id, reaction.text, senderJid, '');
        }
      });

      if (config.ownerJid && !schedulerStarted) {
        schedulerStarted = true;
        initScheduler(async (text) => sendProactiveMessage(config.ownerJid, text));
      }

      if (!startupNotified && config.ownerJid) {
        startupNotified = true;
        setTimeout(async () => {
          try {
            const versionPath = join(__dirname, '..', 'version.json');
            const lastVersionPath = join(config.authStatePath, 'last_version.txt');

            let message = 'Back online.';

            if (existsSync(versionPath)) {
              const { version, notes } = JSON.parse(readFileSync(versionPath, 'utf-8'));
              const lastVersion = existsSync(lastVersionPath) ? readFileSync(lastVersionPath, 'utf-8').trim() : null;

              if (version !== lastVersion && notes?.length > 0) {
                message = `Back online — *v${version}*\n\n` + notes.map((n) => `- ${n}`).join('\n');
                writeFileSync(lastVersionPath, version);
              }
            }

            await sendProactiveMessage(config.ownerJid, message);

            // Seed system knowledge into EVO memory (fire-and-forget)
            if (config.evoMemoryEnabled) {
              seedSystemKnowledge().catch(err =>
                logger.warn({ err: err.message }, 'system knowledge seed failed'),
              );
            }
          } catch (err) {
            logger.error({ err: err.message }, 'startup notification failed');
          }
        }, 3000);
      }
    }

    if (connection === 'close') {
      activeSock = null;
      globalThis._clawdWhatsAppConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        logger.fatal('logged out - delete auth_state and restart');
        process.exit(1);
      }
      logger.warn({ statusCode }, 'disconnected, reconnecting in 5s...');
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// --- Graceful shutdown ---
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down...');

  try { flushUsage(); } catch {}
  try { await flushTodos(); } catch {}
  try { await flushAudit(); } catch {}
  try { flushBufferTimer(); await saveBuffers(); } catch {}
  try { stopWidgetRefresh(); } catch {}

  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error({ err: err?.message || err }, 'unhandled rejection'));

// --- Dashboard auth ---
function checkDashboardAuth(req) {
  if (!config.dashboardToken) return true;
  const url = new URL(req.url, 'http://localhost');
  const tokenParam = url.searchParams.get('token');
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  return (tokenParam === config.dashboardToken) || (bearerToken === config.dashboardToken);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getUrlPath(req) {
  return new URL(req.url, 'http://localhost').pathname;
}

createServer(async (req, res) => {
  const path = getUrlPath(req);

  // --- Public endpoints ---

  if (req.method === 'POST' && path === '/api/send') {
    try {
      const { jid, message } = JSON.parse(await readBody(req));
      if (!jid || !message) return jsonResponse(res, 400, { error: 'jid and message required' });
      await sendProactiveMessage(jid, message);
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  if (path === '/api/status') {
    return jsonResponse(res, 200, {
      connected: !!activeSock,
      name: activeSock?.user?.name || null,
      jid: activeSock?.user?.id || null,
      lastActivity: lastActivityTimestamp,
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    });
  }

  if (path === '/api/usage') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    return jsonResponse(res, 200, getUsageStats());
  }

  // --- Dashboard endpoints (auth required) ---

  if (path === '/dashboard') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const htmlPath = join(__dirname, '..', 'public', 'dashboard.html');
    if (existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(readFileSync(htmlPath, 'utf-8'));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Dashboard not found');
  }

  if (path === '/api/widgets') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const data = await getWidgetData();
      jsonResponse(res, 200, data);
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/widgets/refresh') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      await forceRefresh();
      const data = await getWidgetData();
      jsonResponse(res, 200, data);
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  if (path === '/api/soul') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    return jsonResponse(res, 200, getSoulData());
  }

  if (req.method === 'POST' && path === '/api/soul/reset') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    await resetSoul();
    return jsonResponse(res, 200, { ok: true, message: 'Soul reset to defaults' });
  }

  if (path === '/api/todos') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    return jsonResponse(res, 200, { todos: getAllTodos() });
  }

  if (req.method === 'POST' && path === '/api/todos/complete') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id) return jsonResponse(res, 400, { error: 'id required' });
      const result = await todoComplete({ id });
      broadcastSSE('todos', { todos: getAllTodos() });
      return jsonResponse(res, 200, { ok: true, message: result, todos: getAllTodos() });
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  if (path === '/api/messages') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const messages = config.ownerJid ? getRecentMessages(config.ownerJid) : [];
    return jsonResponse(res, 200, { messages });
  }

  // GET /api/audit — recent tool execution audit log
  if (path === '/api/audit') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const log = await getAuditLog(50);
    return jsonResponse(res, 200, { audit: log });
  }

  // GET /api/quality — interaction quality summary for evolution pipeline
  if (path === '/api/quality') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const days = parseInt(new URL(req.url, 'http://localhost').searchParams.get('days') || '7');
    const summary = getQualitySummary(days);
    const recentFeedback = getRecentFeedback(20);
    return jsonResponse(res, 200, { summary, recentFeedback });
  }

  // GET /api/evo — EVO X2 llama-server health check
  if (path === '/api/evo' || path === '/api/ollama') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const available = await checkEvoLlmHealth();
    return jsonResponse(res, 200, { available, url: config.evoLlmUrl });
  }

  // --- Memory endpoints ---

  // GET /api/memory/status — EVO X2 + memory stats
  if (path === '/api/memory/status') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const evo = getEvoStatus();
    const stats = await getMemoryStats();
    const health = getLastHealthData();
    return jsonResponse(res, 200, { evo, stats, health });
  }

  // GET /api/memory/list — all memories
  if (path === '/api/memory/list') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const memories = await listMemories();
    return jsonResponse(res, 200, { memories, count: memories.length });
  }

  // POST /api/memory/search — search memories
  if (req.method === 'POST' && path === '/api/memory/search') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.query) return jsonResponse(res, 400, { error: 'query required' });
      const results = await searchMemory(body.query, body.category, body.limit || 10);
      return jsonResponse(res, 200, { results });
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/memory/note — store a quick note
  if (req.method === 'POST' && path === '/api/memory/note') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const { text } = JSON.parse(await readBody(req));
      if (!text) return jsonResponse(res, 400, { error: 'text required' });
      const result = await storeNote(text, 'dashboard_note');
      return jsonResponse(res, 200, result);
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // PUT /api/memory/:id — update a memory
  if (req.method === 'PUT' && path.startsWith('/api/memory/mem_')) {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const memoryId = path.split('/').pop();
      const updates = JSON.parse(await readBody(req));
      const result = await updateMemory(memoryId, updates);
      return jsonResponse(res, 200, result);
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // DELETE /api/memory/:id — delete a memory
  if (req.method === 'DELETE' && path.startsWith('/api/memory/mem_')) {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const memoryId = path.split('/').pop();
      const result = await deleteMemory(memoryId);
      return jsonResponse(res, 200, result);
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/voice-local — fast locally-routed voice commands (no Claude call)
  if (req.method === 'POST' && path === '/api/voice-local') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const { action, params = {}, text, tier } = JSON.parse(await readBody(req));
      if (!action) return jsonResponse(res, 400, { error: 'action required' });

      logger.info({ action, params, text, tier }, 'voice-local command');

      let message = '';
      let data = null;

      switch (action) {
        case 'navigate': {
          const panel = params.panel || 'todos';
          broadcastSSE('voice', { event: 'navigate', panel });
          broadcastSSE('voice', { event: 'toast', message: `Showing ${panel}` });
          message = `Navigated to ${panel}`;
          break;
        }

        case 'todo_add': {
          const todoText = params.text || text;
          if (!todoText) return jsonResponse(res, 400, { error: 'text required for todo_add' });
          const result = await todoAdd({ text: todoText, priority: params.priority || 'normal', due_date: params.due_date, reminder: params.reminder });
          broadcastSSE('voice', { event: 'toast', message: `Added: ${todoText}` });
          broadcastSSE('todos', { todos: getAllTodos() });
          message = result;
          break;
        }

        case 'todo_complete': {
          const searchText = (params.text || text || '').toLowerCase();
          if (!searchText) return jsonResponse(res, 400, { error: 'text required for todo_complete' });
          const activeTodos = getActiveTodos();
          // Fuzzy match: case-insensitive substring, prefer shorter todos (more specific match)
          let bestMatch = null;
          let bestScore = -1;
          for (const todo of activeTodos) {
            const todoLower = todo.text.toLowerCase();
            if (todoLower.includes(searchText) || searchText.includes(todoLower)) {
              // Score: exact match > substring in todo > substring in search
              const score = todoLower === searchText ? 3 : todoLower.includes(searchText) ? 2 : 1;
              if (score > bestScore) {
                bestScore = score;
                bestMatch = todo;
              }
            }
          }
          if (!bestMatch) {
            // Fallback: token overlap
            const searchTokens = searchText.split(/\s+/);
            for (const todo of activeTodos) {
              const todoLower = todo.text.toLowerCase();
              const overlap = searchTokens.filter(t => todoLower.includes(t)).length;
              if (overlap > bestScore) {
                bestScore = overlap;
                bestMatch = todo;
              }
            }
          }
          if (!bestMatch) {
            message = `No matching todo found for: "${params.text || text}"`;
            broadcastSSE('voice', { event: 'toast', message: 'No matching todo found' });
          } else {
            const result = await todoComplete({ id: bestMatch.id });
            broadcastSSE('voice', { event: 'toast', message: `Done: ${bestMatch.text}` });
            broadcastSSE('todos', { todos: getAllTodos() });
            message = result;
          }
          break;
        }

        case 'calendar_list': {
          const widgets = await getWidgetData();
          data = widgets.calendar || [];
          broadcastSSE('voice', { event: 'info', data });
          // Build spoken summary from calendar data
          if (data.length === 0) {
            message = 'Nothing coming up';
          } else {
            const lines = data.slice(0, 5).map(ev => {
              const title = ev.summary || ev.title || 'Event';
              const when = ev.when || ev.start || '';
              return when ? `${title}, ${when}` : title;
            });
            message = lines.join('. ');
            if (data.length > 5) message += `. Plus ${data.length - 5} more`;
          }
          break;
        }

        case 'remember': {
          const noteText = params.text || text;
          if (!noteText) return jsonResponse(res, 400, { error: 'text required for remember' });
          const result = await storeNote(noteText, 'voice_note');
          broadcastSSE('voice', { event: 'toast', message: 'Noted' });
          message = result.stored === false ? 'Queued for memory' : 'Stored in memory';
          data = result;
          break;
        }

        case 'refresh': {
          await forceRefresh();
          const freshData = await getWidgetData();
          broadcastSSE('voice', { event: 'toast', message: 'Refreshed' });
          message = 'Dashboard refreshed';
          data = { lastRefresh: freshData.lastRefresh };
          break;
        }

        case 'status': {
          const uptime = process.uptime();
          const mem = process.memoryUsage();
          const hours = Math.floor(uptime / 3600);
          const mins = Math.floor((uptime % 3600) / 60);
          const mbRss = (mem.rss / 1048576).toFixed(0);
          const statusMsg = `Running for ${hours}h ${mins}m. Memory: ${mbRss}MB. WhatsApp: ${activeSock ? 'connected' : 'disconnected'}.`;
          broadcastSSE('voice', { event: 'response', text: statusMsg, command: text, panel: 'admin' });
          message = statusMsg;
          break;
        }

        case 'claude': {
          // Forward to the full Claude pipeline by making an internal-style call
          // We replicate what /api/voice-command does
          const jid = config.ownerJid || 'dashboard';
          const cmdText = params.text || text;
          if (!cmdText) return jsonResponse(res, 400, { error: 'text required for claude action' });

          pushMessage(jid, { senderName: 'James (voice)', text: cmdText, hasImage: false, isBot: false });
          broadcastSSE('message', { sender: 'James (voice)', text: cmdText, timestamp: Date.now() });
          broadcastSSE('voice', { event: 'command', text: cmdText });

          const context = buildContext(jid, cmdText);
          const response = await getClawdResponse(context, 'direct');

          if (response) {
            pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
            broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });

            const lc = (cmdText + ' ' + response).toLowerCase();
            const panels = [];
            if (/\b(calendar|schedule|meeting|event|appointment|diary|tomorrow|today)\b/.test(lc)) panels.push('calendar');
            if (/\b(todo|task|reminder|to.do|shopping)\b/.test(lc)) panels.push('todos');
            if (/\b(email|inbox|gmail|message|draft|send)\b/.test(lc)) panels.push('email');
            if (/\b(weather|rain|temperature|forecast|sun)\b/.test(lc)) panels.push('weather');
            if (/\b(henry|weekend|custody)\b/.test(lc)) panels.push('henry');
            if (/\b(train|travel|hotel|fare|depart)\b/.test(lc)) panels.push('travel');

            broadcastSSE('voice', { event: 'response', text: response, panels, panel: panels[0], command: cmdText });

            if (config.ownerJid && activeSock) {
              try { await sendProactiveMessage(config.ownerJid, response); } catch {}
            }

            return jsonResponse(res, 200, { ok: true, action: 'claude', message: response, data: { panels } });
          } else {
            broadcastSSE('voice', { event: 'no_result' });
            return jsonResponse(res, 200, { ok: true, action: 'claude', message: 'No response', data: null });
          }
        }

        default:
          return jsonResponse(res, 400, { error: `Unknown action: ${action}` });
      }

      return jsonResponse(res, 200, { ok: true, action, message, data });
    } catch (err) {
      logger.error({ err: err.message }, 'voice-local error');
      broadcastSSE('voice', { event: 'toast', message: 'Voice command failed' });
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/voice-command — receive transcribed voice command from wake listener
  if (req.method === 'POST' && path === '/api/voice-command') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const { text, source } = JSON.parse(await readBody(req));
      if (!text) return jsonResponse(res, 400, { error: 'text required' });

      logger.info({ text, source }, 'voice command received');
      const voiceStart = Date.now();
      const jid = config.ownerJid || 'dashboard';
      pushMessage(jid, { senderName: 'James (voice)', text, hasImage: false, isBot: false });
      broadcastSSE('message', { sender: 'James (voice)', text, timestamp: Date.now() });
      broadcastSSE('voice', { event: 'command', text });

      const context = buildContext(jid, text);
      const response = await getClawdResponse(context, 'direct');

      if (response) {
        pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
        broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });

        // Detect context for dashboard panel highlighting
        const lc = (text + ' ' + response).toLowerCase();
        const panels = [];
        if (/\b(calendar|schedule|meeting|event|appointment|diary|tomorrow|today)\b/.test(lc)) panels.push('calendar');
        if (/\b(todo|task|reminder|to.do|shopping)\b/.test(lc)) panels.push('todos');
        if (/\b(email|inbox|gmail|message|draft|send)\b/.test(lc)) panels.push('email');
        if (/\b(weather|rain|temperature|forecast|sun)\b/.test(lc)) panels.push('weather');
        if (/\b(henry|weekend|custody)\b/.test(lc)) panels.push('henry');
        if (/\b(train|travel|hotel|fare|depart)\b/.test(lc)) panels.push('travel');

        broadcastSSE('voice', { event: 'response', text: response, panels, panel: panels[0], command: text });

        // Log voice interaction
        logInteraction({
          sender: { name: 'James', jid },
          source: 'voice',
          input: { text, hadImage: false },
          routing: { mode: 'direct', source: source || 'wake_word' },
          toolsCalled: [],
          response: { text: response, chars: response.length },
          latencyMs: Date.now() - voiceStart,
          messageIds: [],
        });

        if (config.ownerJid && activeSock) {
          try {
            await sendProactiveMessage(config.ownerJid, response);
          } catch (err) {
            logger.error({ err: err.message }, 'voice command WhatsApp relay failed');
          }
        }

        jsonResponse(res, 200, { response, panels });
      } else {
        broadcastSSE('voice', { event: 'no_result' });
        jsonResponse(res, 200, { response: null });
      }
    } catch (err) {
      broadcastSSE('voice', { event: 'error', message: err.message });
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/voice-status — voice listener status updates for dashboard SSE
  if (req.method === 'POST' && path === '/api/voice-status') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const body = JSON.parse(await readBody(req));
      // Record heartbeats for system_status self-awareness
      if (body.event === 'heartbeat') {
        const { recordVoiceHeartbeat } = await import('./tools/handler.js');
        recordVoiceHeartbeat(body);
      }
      broadcastSSE('voice', body);
      return jsonResponse(res, 200, { ok: true });
    } catch (err) {
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // POST /api/desktop-mode — kill kiosk Chromium to expose Pi desktop
  if (req.method === 'POST' && path === '/api/desktop-mode') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      logger.info('desktop mode requested — killing kiosk Chromium');
      exec('touch /tmp/clawd-desktop-mode && pkill chromium', (err) => {
        if (err) logger.warn({ err: err.message }, 'chromium kill returned non-zero (may already be dead)');
      });
      jsonResponse(res, 200, { ok: true, message: 'Kiosk hidden. Use Clawd Desktop shortcut to return.' });
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/chat') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const { message } = JSON.parse(await readBody(req));
      if (!message) return jsonResponse(res, 400, { error: 'message required' });

      const jid = config.ownerJid || 'dashboard';
      pushMessage(jid, { senderName: 'James', text: message, hasImage: false, isBot: false });
      broadcastSSE('message', { sender: 'James', text: message, timestamp: Date.now() });

      const context = buildContext(jid, message);
      const response = await getClawdResponse(context, 'direct');

      if (response) {
        pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
        broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });

        if (config.ownerJid && activeSock) {
          try {
            await sendProactiveMessage(config.ownerJid, response);
          } catch (err) {
            logger.error({ err: err.message }, 'dashboard WhatsApp relay failed');
          }
        }

        jsonResponse(res, 200, { response });
      } else {
        jsonResponse(res, 200, { response: null });
      }
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  if (path === '/api/events') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    addSSEClient(res);
    return;
  }

  // Default: QR code page
  if (activeSock?.user?.id) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Connected as ${activeSock.user.name || 'Clawd'}</h2><p>Dashboard: <a href="/dashboard?token=${config.dashboardToken}">/dashboard</a></p></body></html>`);
  } else if (existsSync('/tmp/qr.png')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const img = readFileSync('/tmp/qr.png').toString('base64');
    res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Scan QR to link WhatsApp</h2><img src="data:image/png;base64,${img}" style="width:400px"/><p style="color:#888">Auto-refreshing every 5s</p></body></html>`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Waiting for QR...</h2><p style="color:#888">Auto-refreshing</p></body></html>');
  }
}).listen(config.httpPort, () => logger.info({ port: config.httpPort }, 'HTTP server started'));

startWidgetRefresh();

startBot();
