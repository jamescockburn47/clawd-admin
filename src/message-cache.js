// Shared sent-message cache for Baileys message retry mechanism.
// When decryption fails, WhatsApp asks the sender to resend the message.
// Baileys calls getMessage(key) — this cache provides the original content.

import NodeCache from '@cacheable/node-cache';

// Caches sent message content for 5 minutes (enough for retry cycles)
const sentMessageCache = new NodeCache({ stdTTL: 300, useClones: false });

// Retry counter cache — tracks how many times a message retry has been attempted (10 min TTL)
const msgRetryCounterCache = new NodeCache({ stdTTL: 600, useClones: false });

/**
 * Store a sent message for potential retry.
 * @param {string} msgId - Message ID from sent.key.id
 * @param {object} message - The proto.IMessage content
 */
export function cacheSentMessage(msgId, message) {
  if (msgId && message) sentMessageCache.set(msgId, message);
}

/**
 * Retrieve a cached message for retry.
 * @param {string} msgId - Message ID to look up
 * @returns {object|undefined} The cached message or undefined
 */
export function getCachedMessage(msgId) {
  return sentMessageCache.get(msgId);
}

export { msgRetryCounterCache };
