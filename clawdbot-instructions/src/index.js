import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { createServer } from 'http';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import config from './config.js';
import { shouldRespond, recordRandomCooldown } from './trigger.js';
import { pushMessage, buildContext } from './buffer.js';
import { getMonetResponse } from './claude.js';

const logger = pino({ level: 'warn' });

function printBanner() {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     CLAWDBOT MONET                   ║
  ║     "I must have flowers, always"     ║
  ╚══════════════════════════════════════╝

  Model:    ${config.claudeModel}
  Prefix:   ${config.triggerPrefix}
  Random:   ${(config.randomReplyChance * 100).toFixed(0)}% base / +${(config.keywordBoostChance * 100).toFixed(0)}% keyword boost
  Cooldown: ${config.randomCooldownSeconds}s
  Context:  ${config.contextMessageCount} messages
  Limit:    ${config.dailyCallLimit} calls/day
  Group:    ${config.whatsappGroupJid || '(all groups)'}
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

function hasImage(message) {
  return !!message.message?.imageMessage;
}

function isReplyToBot(message, botJid) {
  const quoted = message.message?.extendedTextMessage?.contextInfo;
  return quoted?.participant === botJid;
}

async function simulateTyping(sock, groupJid, responseLength) {
  await sock.presenceSubscribe(groupJid);
  await sock.sendPresenceUpdate('composing', groupJid);

  const baseDelay = 500 + Math.random() * 1500;
  const lengthDelay = Math.min(responseLength * 15, 3000);
  const totalDelay = Math.min(baseDelay + lengthDelay, 5000);

  await new Promise((r) => setTimeout(r, totalDelay));
  await sock.sendPresenceUpdate('paused', groupJid);
}

async function handleMessage(sock, message, botJid) {
  try {
    const groupJid = message.key.remoteJid;
    if (!groupJid?.endsWith('@g.us')) return;

    const senderJid = message.key.participant || message.key.remoteJid;
    const senderName = message.pushName || 'Unknown';
    const text = extractText(message);
    const msgHasImage = hasImage(message);

    // Log every message (helps user find group JID)
    console.log(`[msg] ${groupJid} | ${senderName}: ${text || (msgHasImage ? '[photo]' : '[empty]')}`);

    // Skip empty messages
    if (!text && !msgHasImage) return;

    // Push to buffer
    pushMessage(groupJid, {
      senderName,
      text,
      hasImage: msgHasImage,
      isBot: false,
    });

    // Check for reply-to-bot (counts as direct trigger)
    const repliedToBot = isReplyToBot(message, botJid);

    // Get mentioned JIDs
    const mentionedJids = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    // Trigger decision
    const trigger = shouldRespond({
      text,
      hasImage: msgHasImage,
      isFromMe: message.key.fromMe,
      isGroup: true,
      senderJid,
      botJid,
      groupJid,
      mentionedJids,
    });

    // Reply-to-bot overrides trigger
    if (!trigger.respond && repliedToBot && !message.key.fromMe) {
      trigger.respond = true;
      trigger.mode = 'direct';
    }

    if (!trigger.respond) return;

    console.log(`[trigger] ${trigger.mode} trigger in ${groupJid}`);

    // Build context
    let messageText = text;
    if (trigger.mode === 'direct' && messageText.toLowerCase().startsWith(config.triggerPrefix.toLowerCase())) {
      messageText = messageText.slice(config.triggerPrefix.length).trim();
    }

    const context = buildContext(groupJid, messageText);

    // Call Claude
    const response = await getMonetResponse(context, trigger.mode);
    if (!response) return;

    // Simulate typing
    await simulateTyping(sock, groupJid, response.length);

    // Send response
    await sock.sendMessage(groupJid, { text: response });

    // Push bot response to buffer
    pushMessage(groupJid, {
      senderName: 'Monet',
      text: response,
      hasImage: false,
      isBot: true,
    });

    // Record cooldown for random interjections
    if (trigger.mode === 'random') {
      recordRandomCooldown();
    }

    console.log(`[sent] ${trigger.mode} response (${response.length} chars)`);
  } catch (err) {
    console.error('[handler] Error processing message:', err.message);
  }
}

async function startBot() {
  printBanner();

  const { state, saveCreds } = await useMultiFileAuthState(config.authStatePath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['Clawdbot', 'Chrome', '122.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    printQRInTerminal: false,
  });

  // Pairing code support — request once on first QR
  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr && config.pairingPhoneNumber) {
      if (!pairingRequested) {
        pairingRequested = true;
        console.log('\n  Requesting pairing code...\n');
        const code = await sock.requestPairingCode(config.pairingPhoneNumber);
        console.log(`  ┌─────────────────────────────────┐`);
        console.log(`  │  PAIRING CODE:  ${code}          │`);
        console.log(`  └─────────────────────────────────┘`);
        console.log(`\n  On your phone: WhatsApp → Linked Devices → Link a Device → Link with phone number\n`);
      }
    } else if (qr) {
      console.log('\n  Scan this QR code with WhatsApp:\n');
      qrcode.generate(qr, { small: true });

      // Also serve QR as image on port 8080 for BlueStacks scanning
      try {
        writeFileSync('/tmp/qr.txt', qr);
        execSync('qrencode -o /tmp/qr.png -s 10 -m 2 < /tmp/qr.txt');
        console.log(`\n  QR also available at: http://187.77.176.22:8080\n`);
      } catch (e) {
        console.log('  (Could not generate QR image)');
      }
    }

    if (connection === 'open') {
      const botJid = sock.user?.id;
      console.log(`\n  Connected as ${sock.user?.name || 'unknown'} (${botJid})\n`);

      // Register message handler with bot JID
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          handleMessage(sock, msg, botJid);
        }
      });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.output?.payload?.error;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error(`\n  LOGGED OUT. Delete the ${config.authStatePath} directory and restart to re-scan QR code.\n`);
        process.exit(1);
      }

      console.log(`  Disconnected (${reason || statusCode}). Reconnecting in 5s...`);
      setTimeout(startBot, 5000);
    }
  });

  // Persist auth state
  sock.ev.on('creds.update', saveCreds);
}

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n  ${signal} received. The water lilies will wait. Au revoir.\n`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.message || err);
});

// Simple HTTP server to serve QR code image for BlueStacks scanning
createServer((req, res) => {
  if (existsSync('/tmp/qr.png')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const img = readFileSync('/tmp/qr.png').toString('base64');
    res.end(`<html><body style="text-align:center;padding:40px;background:#fff">
      <h2>Scan this QR in WhatsApp</h2>
      <p>Long-press the image → Save → then use WhatsApp gallery scanner</p>
      <img src="data:image/png;base64,${img}" style="width:400px;height:400px"/>
    </body></html>`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="text-align:center;padding:40px"><h2>Waiting for QR code...</h2><p>Refresh in a few seconds</p></body></html>');
  }
}).listen(8080, () => console.log('  QR web server on port 8080'));

startBot();
