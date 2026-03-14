import config from './config.js';

const buffers = new Map();

export function pushMessage(groupJid, entry) {
  if (!buffers.has(groupJid)) {
    buffers.set(groupJid, []);
  }
  const buf = buffers.get(groupJid);
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

export function buildContext(groupJid, triggerText) {
  const buf = buffers.get(groupJid) || [];
  if (buf.length === 0) return triggerText;

  const lines = buf.map((msg) => {
    const name = msg.isBot ? 'Monet (you)' : msg.senderName;
    const content = msg.hasImage && !msg.text ? '[sent a photo]'
      : msg.hasImage ? `${msg.text} [sent a photo]`
      : msg.text;
    return `${name}: ${content}`;
  });

  return `[Recent group conversation]\n${lines.join('\n')}`;
}
