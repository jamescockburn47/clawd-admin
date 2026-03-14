import config from './config.js';

const KEYWORDS = new Set([
  // Art terms
  'paint', 'painting', 'art', 'artist', 'gallery', 'museum', 'exhibition',
  'canvas', 'colour', 'color', 'impressionism', 'portrait', 'landscape',
  'sculpture', 'photograph', 'aesthetic', 'beautiful', 'ugly', 'gorgeous',
  'hideous', 'stunning',
  // Artist names
  'monet', 'manet', 'renoir', 'picasso', 'van gogh', 'cezanne', 'warhol',
  'banksy', 'rembrandt', 'da vinci', 'michelangelo',
  // Art media
  'watercolour', 'watercolor', 'oil paint', 'acrylic', 'fresco',
  // Food
  'dinner', 'lunch', 'recipe', 'cook', 'cooking', 'restaurant', 'delicious',
  'disgusting', 'meal', 'dish', 'sauce', 'wine', 'cheese', 'bread', 'pastry',
  'café', 'cafe', 'kitchen',
  // Visual/scenic
  'sunset', 'sunrise', 'garden', 'flower', 'flowers', 'light', 'shadow',
  'sky', 'cloud', 'river', 'lake', 'sea',
  // Interior/fashion
  'decor', 'wallpaper', 'curtain', 'furniture', 'ikea', 'outfit', 'dress',
  'fashion', 'style', 'interior',
  // Photography
  'photo', 'selfie', 'camera', 'filter',
  // Aesthetic outrage triggers
  'beige', 'grey', 'gray', 'minimalist', 'modern art', 'nft', 'ai art',
  'ai generated',
]);

let lastRandomTimestamp = 0;

function containsKeyword(text) {
  const lower = text.toLowerCase();
  for (const keyword of KEYWORDS) {
    if (lower.includes(keyword)) return true;
  }
  return false;
}

export function shouldRespond({ text, hasImage, isFromMe, isGroup, senderJid, botJid, groupJid, mentionedJids }) {
  // Never respond to own messages
  if (isFromMe || senderJid === botJid) {
    return { respond: false };
  }

  // Only respond in groups
  if (!isGroup) {
    return { respond: false };
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

  // 2. Name mention in text
  if (lowerText.includes('monet') || lowerText.includes('clawdbot')) {
    return { respond: true, mode: 'direct' };
  }

  // 3. @mention via JID
  if (mentionedJids && mentionedJids.includes(botJid)) {
    return { respond: true, mode: 'direct' };
  }

  // Probabilistic triggers — with cooldown
  const now = Date.now();
  const cooldownMs = config.randomCooldownSeconds * 1000;
  if (now - lastRandomTimestamp < cooldownMs) {
    return { respond: false };
  }

  let chance = config.randomReplyChance;

  if (text && containsKeyword(text)) {
    chance += config.keywordBoostChance;
  }

  if (hasImage) {
    chance += 0.15;
  }

  if (Math.random() < chance) {
    return { respond: true, mode: 'random' };
  }

  return { respond: false };
}

export function recordRandomCooldown() {
  lastRandomTimestamp = Date.now();
}
