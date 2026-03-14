import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { shouldRespond, recordRandomCooldown } from './trigger.js';
import { pushMessage, buildContext, getRecentMessages } from './buffer.js';
import { getClawdResponse, getUsageStats } from './claude.js';
import { getWidgetData, startWidgetRefresh, addSSEClient, broadcastSSE, forceRefresh } from './widgets.js';
import { getSoulData, resetSoul } from './tools/soul.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const logger = pino({ level: 'warn' });

function printBanner() {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     CLAWD — Admin Assistant          ║
  ╚══════════════════════════════════════╝

  Model:    ${config.claudeModel}
  Prefix:   ${config.triggerPrefix}
  Limit:    ${config.dailyCallLimit} calls/day
  Group:    ${config.whatsappGroupJid || '(all groups)'}
  HTTP:     port ${config.httpPort}
`);
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
    // Try to split at a paragraph break (double newline)
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    // Fall back to single newline
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    }
    // Fall back to space
    if (splitIdx < MAX_MESSAGE_LENGTH * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    // Hard cut if nothing works
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

async function handleMessage(sock, message, botJid) {
  try {
    const chatJid = message.key.remoteJid;
    const isGroup = chatJid?.endsWith('@g.us');
    const senderJid = message.key.participant || chatJid;
    const senderName = message.pushName || 'Unknown';
    const text = extractText(message);
    const msgHasImage = hasImageMsg(message);

    console.log(`[msg] ${chatJid} | ${senderName}: ${text || (msgHasImage ? '[photo]' : '[empty]')}`);

    if (!text && !msgHasImage) return;

    pushMessage(chatJid, {
      senderName,
      text,
      hasImage: msgHasImage,
      isBot: false,
    });

    // Broadcast incoming messages from owner to dashboard
    if (chatJid === config.ownerJid && text) {
      broadcastSSE('message', { sender: senderName, text, timestamp: Date.now() });
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

    console.log(`[trigger] ${trigger.mode} in ${chatJid}`);

    let messageText = text;
    if (messageText.toLowerCase().startsWith(config.triggerPrefix.toLowerCase())) {
      messageText = messageText.slice(config.triggerPrefix.length).trim();
    }

    const context = buildContext(chatJid, messageText);
    const response = await getClawdResponse(context, trigger.mode, senderJid);
    if (!response) return;

    await simulateTyping(sock, chatJid, response.length);

    // Split long messages to avoid mobile WhatsApp "waiting for this message" issue
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

    // Broadcast Clawd's response to dashboard (full response, not chunks)
    if (chatJid === config.ownerJid) {
      broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });
    }

    if (trigger.mode === 'random') {
      recordRandomCooldown();
    }

    console.log(`[sent] ${trigger.mode} (${response.length} chars)`);
  } catch (err) {
    console.error('[handler] Error:', err.message);
  }
}

// Shared socket reference for the HTTP API
let activeSock = null;

async function sendProactiveMessage(jid, text) {
  if (!activeSock) throw new Error('Socket not connected');
  await simulateTyping(activeSock, jid, text.length);
  await activeSock.sendMessage(jid, { text });
  pushMessage(jid, { senderName: 'Clawd', text, hasImage: false, isBot: true });
  console.log(`[proactive] Sent to ${jid} (${text.length} chars)`);
}

async function startBot() {
  printBanner();

  const { state, saveCreds } = await useMultiFileAuthState(config.authStatePath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['Clawd', 'Chrome', '122.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
  });

  let pairingRequested = false;
  let startupNotified = false;

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && config.pairingPhoneNumber) {
      if (!pairingRequested) {
        pairingRequested = true;
        console.log('\n  Requesting pairing code...\n');
        const code = await sock.requestPairingCode(config.pairingPhoneNumber);
        console.log(`  PAIRING CODE: ${code}\n`);
      }
    } else if (qr) {
      qrcode.generate(qr, { small: true });
      try {
        writeFileSync('/tmp/qr.txt', qr);
        execSync('qrencode -o /tmp/qr.png -s 10 -m 2 < /tmp/qr.txt');
        console.log('\n  QR also at http://187.77.176.22:8080\n');
      } catch (_) {}
    }

    if (connection === 'open') {
      const botJid = sock.user?.id;
      activeSock = sock;
      console.log(`\n  Connected as ${sock.user?.name || 'unknown'} (${botJid})\n`);

      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          handleMessage(sock, msg, botJid);
        }
      });

      // One-time startup notification to owner — announces changes if version is new
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
                message = `Back online — *v${version}*\n\n` + notes.map((n) => `• ${n}`).join('\n');
                writeFileSync(lastVersionPath, version);
              }
            }

            await sendProactiveMessage(config.ownerJid, message);
          } catch (err) {
            console.error('[startup-notify] Failed:', err.message);
          }
        }, 3000);
      }
    }

    if (connection === 'close') {
      activeSock = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('  LOGGED OUT. Delete auth_state and restart.');
        process.exit(1);
      }
      console.log('  Disconnected. Reconnecting in 5s...');
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

process.on('SIGINT', () => { console.log('\n  Shutting down.'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  Shutting down.'); process.exit(0); });
process.on('unhandledRejection', (err) => console.error('[error]', err?.message || err));

// --- Dashboard auth ---
function checkDashboardAuth(req) {
  if (!config.dashboardToken) return true; // no token = no auth required
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

  // POST /api/send — send a proactive message
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

  // GET /api/status — bot health check
  if (path === '/api/status') {
    return jsonResponse(res, 200, {
      connected: !!activeSock,
      name: activeSock?.user?.name || null,
      jid: activeSock?.user?.id || null,
    });
  }

  // GET /api/usage — token usage and cost
  if (path === '/api/usage') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    return jsonResponse(res, 200, getUsageStats());
  }

  // --- Dashboard endpoints (auth required) ---

  // GET /dashboard — serve the dashboard HTML
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

  // GET /api/widgets — cached widget data
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

  // POST /api/widgets/refresh — force widget refresh
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

  // GET /api/soul — current soul state for dashboard
  if (path === '/api/soul') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    return jsonResponse(res, 200, getSoulData());
  }

  // POST /api/soul/reset — emergency reset soul to empty defaults
  if (req.method === 'POST' && path === '/api/soul/reset') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    resetSoul();
    return jsonResponse(res, 200, { ok: true, message: 'Soul reset to defaults' });
  }

  // GET /api/messages — recent messages from owner DM
  if (path === '/api/messages') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    const messages = config.ownerJid ? getRecentMessages(config.ownerJid) : [];
    return jsonResponse(res, 200, { messages });
  }

  // POST /api/chat — send message to Clawd from dashboard
  if (req.method === 'POST' && path === '/api/chat') {
    if (!checkDashboardAuth(req)) return jsonResponse(res, 401, { error: 'Unauthorized' });
    try {
      const { message } = JSON.parse(await readBody(req));
      if (!message) return jsonResponse(res, 400, { error: 'message required' });

      // Push as user message in owner's buffer
      const jid = config.ownerJid || 'dashboard';
      pushMessage(jid, { senderName: 'James', text: message, hasImage: false, isBot: false });

      // Broadcast to SSE clients
      broadcastSSE('message', { sender: 'James', text: message, timestamp: Date.now() });

      // Get Clawd response
      const context = buildContext(jid, message);
      const response = await getClawdResponse(context, 'direct');

      if (response) {
        pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
        broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });

        // Also send on WhatsApp so the conversation stays synced
        if (config.ownerJid && activeSock) {
          try {
            await sendProactiveMessage(config.ownerJid, response);
          } catch (err) {
            console.error('[dashboard] WhatsApp relay failed:', err.message);
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

  // GET /api/events — SSE stream
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

  // Default: QR code page (auto-refreshes every 5s so QR stays fresh)
  if (activeSock?.user?.id) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>✅ Connected as ${activeSock.user.name || 'Clawd'}</h2><p>Dashboard: <a href="/dashboard?token=${config.dashboardToken}">/dashboard</a></p></body></html>`);
  } else if (existsSync('/tmp/qr.png')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const img = readFileSync('/tmp/qr.png').toString('base64');
    res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Scan QR to link WhatsApp</h2><img src="data:image/png;base64,${img}" style="width:400px"/><p style="color:#888">Auto-refreshing every 5s</p></body></html>`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Waiting for QR...</h2><p style="color:#888">Auto-refreshing</p></body></html>');
  }
}).listen(config.httpPort, () => console.log(`  HTTP server on port ${config.httpPort}`));

// Start widget cache refresh
startWidgetRefresh();

startBot();
