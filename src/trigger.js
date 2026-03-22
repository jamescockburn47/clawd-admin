import config from './config.js';
const BOT_NAMES = ['clawd', 'clawdbot', 'claude', 'assistant'];

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

  // Group chats: @mention or prefix only
  // 1. @mention via JID
  if (mentionedJids && mentionedJids.includes(botJid)) {
    return { respond: true, mode: 'direct' };
  }

  // 2. Prefix command (e.g. "clawd ...")
  if (lowerText.startsWith(config.triggerPrefix.toLowerCase())) {
    return { respond: true, mode: 'direct' };
  }

  // 3. Bot name mentioned in text (acts like an informal @mention)
  for (const name of BOT_NAMES) {
    if (lowerText.includes(name)) {
      return { respond: true, mode: 'direct' };
    }
  }

  return { respond: true, mode: 'passive' };
}
