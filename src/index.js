import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import logger from './logger.js';
import { shouldRespond, recordRandomCooldown } from './trigger.js';
import { pushMessage, buildContext, getRecentMessages, loadBuffers, saveBuffers, flushBufferTimer } from './buffer.js';
import { getClawdResponse, getUsageStats, flushUsage } from './claude.js';
import { getWidgetData, startWidgetRefresh, stopWidgetRefresh, addSSEClient, broadcastSSE, forceRefresh } from './widgets.js';
import { getSoulData, resetSoul } from './tools/soul.js';
import { getAllTodos, getActiveTodos, flushTodos } from './tools/todo.js';
import { todoComplete } from './tools/todo.js';
import { initScheduler } from './scheduler.js';
import { getAuditLog, flushAudit } from './audit.js';
import { checkEvoOllamaHealth } from './ollama.js';
import { getEvoStatus, getMemoryStats, listMemories, searchMemory, storeNote, updateMemory, deleteMemory, logConversation, checkEvoHealth, getLastHealthData } from './memory.js';

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
  EVO X2:   ${config.evoToolEnabled ? config.evoToolModel : 'disabled'}`;
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

    const context = buildContext(chatJid, messageText);
    const response = await getClawdResponse(context, trigger.mode, senderJid, imageData);
    if (!response) return;

    await simulateTyping(sock, chatJid, response.length);

    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await sock.sendMessage(chatJid, { text: chunk });
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

    // Log conversation for overnight memory extraction
    if (config.evoMemoryEnabled) {
      try {
        logConversation(chatJid, [
          { senderName: senderName, text: messageText, isBot: false },
          { senderName: 'Clawd', text: response, isBot: true },
        ]);
      } catch {}
    }

    if (trigger.mode === 'random') {
      recordRandomCooldown();
    }

    logger.info({ mode: trigger.mode, chars: response.length }, 'response sent');
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
      logger.info({ name: sock.user?.name, jid: botJid }, 'WhatsApp connected');

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          handleMessage(sock, msg, botJid);
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
          } catch (err) {
            logger.error({ err: err.message }, 'startup notification failed');
          }
        }, 3000);
      }
    }

    if (connection === 'close') {
      activeSock = null;
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

  // GET /api/ollama — EVO X2 model health check
  if (path === '/api/ollama') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const available = await checkEvoOllamaHealth();
    return jsonResponse(res, 200, { available, model: config.evoToolModel });
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
