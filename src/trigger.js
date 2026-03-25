import config from './config.js';

// Only respond in groups when directly addressed.
// 'claude' and 'assistant' deliberately excluded — too broad, matches general AI discussion.
const BOT_NAMES = ['clawd', 'clawdbot'];

export function shouldRespond({ text, hasImage, isFromMe, isGroup, senderJid, botJid, groupJid, mentionedJids }) {
  // Never respond to own messages
  if (isFromMe || senderJid === botJid) {
    return { respond: false };
  }

  // Always respond to DMs
  if (!isGroup) {
    return { respond: true, mode: 'direct' };
  }

  // Only respond in configured group (if set)
  if (config.whatsappGroupJid && groupJid !== config.whatsappGroupJid) {
    return { respond: false };
  }

  // Skip empty messages
  if (!text && !hasImage) {
    return { respond: false };
  }

  const lowerText = (text || '').toLowerCase();

  // Group chats: ONLY respond when directly addressed
  // 1. @mention via JID (WhatsApp tag)
  if (mentionedJids && mentionedJids.includes(botJid)) {
    return { respond: true, mode: 'direct' };
  }

  // 2. Prefix command (e.g. "clawd ...")
  if (lowerText.startsWith(config.triggerPrefix.toLowerCase())) {
    return { respond: true, mode: 'direct' };
  }

  // 3. Bot name mentioned in text (informal address)
  for (const name of BOT_NAMES) {
    if (lowerText.includes(name)) {
      return { respond: true, mode: 'direct' };
    }
  }

  // Not addressed → silent. No passive mode, no classifier needed.
  return { respond: false };
}
