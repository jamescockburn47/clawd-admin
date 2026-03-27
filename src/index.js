// src/index.js — Application entry point
// Initialises WhatsApp socket, wires up message handler, starts HTTP server and scheduler.
// No business logic — delegates to message-handler, http-server, and other modules.

import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import config from './config.js';
import logger from './logger.js';
import { loadBuffers, saveBuffers, pushMessage, flushBufferTimer } from './buffer.js';
import { flushUsage } from './claude.js';
import { stopWidgetRefresh } from './widgets.js';
import { setSendOwnerDM, setSendWhatsApp, setSendDocument } from './tools/handler.js';
import { flushTodos } from './tools/todo.js';
import { flushAudit } from './audit.js';
import { seedSystemKnowledge } from './system-knowledge.js';
import { initScheduler } from './scheduler.js';
import { handleIncomingMessage, handleReaction, simulateTyping } from './message-handler.js';
import { startHttpServer } from './http-server.js';
import { cacheSentMessage, getCachedMessage, msgRetryCounterCache } from './message-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const baileysLogger = pino({ level: 'warn' });

// Track last activity for health status
let lastActivityTimestamp = Date.now();

// Shared socket reference for the HTTP API and proactive messages
let activeSock = null;


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

async function sendProactiveMessage(jid, text) {
  if (!activeSock) throw new Error('Socket not connected');
  await simulateTyping(activeSock, jid, text.length);
  const sent = await activeSock.sendMessage(jid, { text });
  if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
  pushMessage(jid, { senderName: 'Clawd', text, hasImage: false, isBot: true });
  logger.info({ jid, chars: text.length }, 'proactive message sent');
}

async function sendDocument(jid, buffer, fileName, mimetype = 'text/markdown', caption = '') {
  if (!activeSock) throw new Error('Socket not connected');
  const msg = { document: buffer, mimetype, fileName };
  if (caption) msg.caption = caption;
  const sent = await activeSock.sendMessage(jid, msg);
  if (sent?.key?.id) cacheSentMessage(sent.key.id, sent.message);
  logger.info({ jid, fileName, size: buffer.length }, 'document sent');
  return sent;
}

async function startBot() {
  printBanner();

  // Load persisted message buffers before connecting
  await loadBuffers();

  const { state, saveCreds } = await useMultiFileAuthState(config.authStatePath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    logger: baileysLogger,
    browser: ['Clawd', 'Chrome', '122.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
    msgRetryCounterCache,
    getMessage: async (key) => getCachedMessage(key.id),
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
      const botLid = sock.user?.lid || null;
      activeSock = sock;
      globalThis._clawdWhatsAppConnected = true;
      globalThis._clawdBotLid = botLid;
      logger.info({ name: sock.user?.name, jid: botJid, lid: botLid }, 'WhatsApp connected');

      // Wire up owner DM callback for soul proposals and tool handler
      if (config.ownerJid) {
        setSendOwnerDM(async (text) => {
          await sock.sendMessage(config.ownerJid, { text });
        });
        setSendWhatsApp(async (text) => {
          await sendProactiveMessage(config.ownerJid, text);
        });
        setSendDocument(async (buffer, fileName, mimetype, caption) => {
          await sendDocument(config.ownerJid, buffer, fileName, mimetype, caption);
        });
      }

      // Wire up message handler
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          lastActivityTimestamp = Date.now();
          handleIncomingMessage(sock, msg, botJid);
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

      // Start scheduler (once only, guard against reconnects)
      if (config.ownerJid && !schedulerStarted) {
        schedulerStarted = true;
        initScheduler(async (text) => sendProactiveMessage(config.ownerJid, text));
      }

      // Startup notification (version change only)
      if (!startupNotified && config.ownerJid) {
        startupNotified = true;
        setTimeout(async () => {
          try {
            const versionPath = join(__dirname, '..', 'version.json');
            const lastVersionPath = join(config.authStatePath, 'last_version.txt');

            let message = null;

            if (existsSync(versionPath)) {
              const { version, notes } = JSON.parse(readFileSync(versionPath, 'utf-8'));
              const lastVersion = existsSync(lastVersionPath) ? readFileSync(lastVersionPath, 'utf-8').trim() : null;

              if (version !== lastVersion && notes?.length > 0) {
                message = `Back online — *v${version}*\n\n` + notes.map((n) => `- ${n}`).join('\n');
                writeFileSync(lastVersionPath, version);
              }
            }

            if (message) await sendProactiveMessage(config.ownerJid, message);

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

// --- Start HTTP server and bot ---

startHttpServer(config.httpPort, {
  getActiveSock: () => activeSock,
  sendProactiveMessage,
  getLastActivity: () => lastActivityTimestamp,
});

startBot();
