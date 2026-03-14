import config from './config.js';

const buffers = new Map();

export function pushMessage(chatJid, entry) {
  if (!buffers.has(chatJid)) {
    buffers.set(chatJid, []);
  }
  const buf = buffers.get(chatJid);
  buf.push({
    senderName: entry.senderName || 'Unknown',
    text: entry.text || '',
    hasImage: entry.hasImage || false,
    isBot: entry.isBot || false,
    timestamp: entry.timestamp || Date.now(),
  });
  if (buf.length > config.contextMessageCount) {
    buf.shift();
  }
}

export function buildContext(chatJid, triggerText) {
  const buf = buffers.get(chatJid) || [];
  if (buf.length === 0) return triggerText;

  const lines = buf.map((msg) => {
    const name = msg.isBot ? 'Clawd (you)' : msg.senderName;
    const content = msg.hasImage && !msg.text ? '[sent a photo]'
      : msg.hasImage ? `${msg.text} [sent a photo]`
      : msg.text;
    return `${name}: ${content}`;
  });

  return `[Recent conversation]\n${lines.join('\n')}`;
}

export function botRecentlySpokeIn(chatJid) {
  const buf = buffers.get(chatJid) || [];
  const recent = buf.slice(-4);
  return recent.some((msg) => msg.isBot);
}

export function getRecentMessages(chatJid) {
  return buffers.get(chatJid) || [];
}
