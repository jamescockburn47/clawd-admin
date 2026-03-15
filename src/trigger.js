import config from './config.js';
import { botRecentlySpokeIn } from './buffer.js';

const BOT_NAMES = ['clawd', 'clawdbot', 'claude', 'assistant'];

let lastRandomTimestamp = 0;

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

  // Direct triggers — always respond

  // 1. Prefix command
  if (lowerText.startsWith(config.triggerPrefix.toLowerCase())) {
    return { respond: true, mode: 'direct' };
  }

  // 2. Bot name mentioned in text
  for (const name of BOT_NAMES) {
    if (lowerText.includes(name)) {
      return { respond: true, mode: 'direct' };
    }
  }

  // 3. @mention via JID
  if (mentionedJids && mentionedJids.includes(botJid)) {
    return { respond: true, mode: 'direct' };
  }

  // 4. Task/reminder patterns — respond without prefix (MG can say "remind james to X")
  if (/\b(remind\s+(james|him|me)|add\s+(to\s+)?(the\s+)?(to-?do|list|tasks?)|don'?t\s+forget|put\s+(it\s+)?on\s+the\s+list)\b/i.test(lowerText)) {
    return { respond: true, mode: 'direct' };
  }

  // Conversation flow — respond if bot recently spoke and message looks directed
  const recentlySpoke = botRecentlySpokeIn(groupJid);

  if (recentlySpoke) {
    // If it's a question, very likely directed at bot
    if (lowerText.includes('?') || lowerText.startsWith('what') || lowerText.startsWith('how') ||
        lowerText.startsWith('when') || lowerText.startsWith('where') || lowerText.startsWith('why') ||
        lowerText.startsWith('can you') || lowerText.startsWith('could you') ||
        lowerText.startsWith('do you') || lowerText.startsWith('will you') ||
        lowerText.startsWith('yes') || lowerText.startsWith('no') || lowerText.startsWith('ok') ||
        lowerText.startsWith('sure') || lowerText.startsWith('thanks') || lowerText.startsWith('cheers')) {
      return { respond: true, mode: 'direct' };
    }
    // Bot recently spoke, moderate chance of follow-up
    if (Math.random() < 0.6) {
      return { respond: true, mode: 'direct' };
    }
  }

  // Low random chance in groups
  const now = Date.now();
  const cooldownMs = config.randomCooldownSeconds * 1000;
  if (now - lastRandomTimestamp < cooldownMs) {
    return { respond: false };
  }

  if (Math.random() < config.randomReplyChance) {
    return { respond: true, mode: 'random' };
  }

  return { respond: false };
}

export function recordRandomCooldown() {
  lastRandomTimestamp = Date.now();
}
