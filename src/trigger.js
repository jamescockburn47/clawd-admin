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
  // 1. @mention via JID or LID (WhatsApp tag)
  //    WhatsApp sends mentions as either phone JID (@s.whatsapp.net) or
  //    Linked ID (@lid). Bot must check both formats.
  if (mentionedJids && mentionedJids.length > 0) {
    const normBotJid = (botJid || '').replace(/:\d+@/, '@');
    const botLid = globalThis._clawdBotLid || null;

    const normBotLid = botLid ? botLid.replace(/:\d+@/, '@') : null;

    const mentioned = mentionedJids.some(jid => {
      const normJid = jid.replace(/:\d+@/, '@');
      // Match against phone JID
      if (normJid === normBotJid) return true;
      // Match against LID (both sides normalised — strip :1 device suffix)
      if (normBotLid && normJid === normBotLid) return true;
      return false;
    });

    if (mentioned) {
      return { respond: true, mode: 'direct' };
    }
  }

  // 2. Prefix command (e.g. "clawd ...")
  if (lowerText.startsWith(config.triggerPrefix.toLowerCase())) {
    return { respond: true, mode: 'direct' };
  }

  // 3. Bot name mentioned in text — route through engagement classifier, not direct.
  //    "clawd" in text doesn't mean Clawd is being addressed — could be discussion
  //    about the bot. Only @mention and prefix commands are truly direct.
  for (const name of BOT_NAMES) {
    if (lowerText.includes(name)) {
      return { respond: true, mode: 'passive' };
    }
  }

  // Not addressed → silent. No passive mode, no classifier needed.
  return { respond: false };
}
