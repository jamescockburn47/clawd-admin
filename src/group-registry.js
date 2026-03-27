// src/group-registry.js — Per-group configuration and content restrictions
// Maps WhatsApp group JIDs to labels and confidentiality rules.
// Data lives in data/group-registry.json, hot-reloaded every 5 minutes.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const REGISTRY_FILE = join('data', 'group-registry.json');
const RELOAD_INTERVAL_MS = 300_000; // 5 minutes

let registry = { groups: {} };
let lastLoadedAt = 0;

/**
 * Load or reload the group registry from disk.
 */
function loadRegistry() {
  try {
    if (!existsSync(REGISTRY_FILE)) return;
    const data = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    registry = data;
    lastLoadedAt = Date.now();
    const count = Object.keys(registry.groups || {}).length;
    if (count > 0) {
      logger.info({ count }, 'group-registry loaded');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'group-registry: failed to load');
  }
}

function ensureLoaded() {
  if (Date.now() - lastLoadedAt > RELOAD_INTERVAL_MS) loadRegistry();
}

// Initial load
loadRegistry();

/**
 * Get the config for a specific group. Returns null if not registered.
 * @param {string} chatJid - WhatsApp group JID
 * @returns {{ label: string, blockedTopics?: string[], confidentialityPrompt?: string } | null}
 */
export function getGroupConfig(chatJid) {
  ensureLoaded();
  if (!chatJid || !registry.groups) return null;
  return registry.groups[chatJid] || null;
}

/**
 * Get the group label (human-readable name) or null.
 */
export function getGroupLabel(chatJid) {
  const config = getGroupConfig(chatJid);
  return config?.label || null;
}

/**
 * Build a confidentiality prompt fragment for a group.
 * Returns empty string if no restrictions apply.
 */
export function getGroupRestrictions(chatJid) {
  const config = getGroupConfig(chatJid);
  if (!config) return '';

  const parts = [];

  // Custom confidentiality prompt (free-form, written by James)
  if (config.confidentialityPrompt) {
    parts.push(config.confidentialityPrompt);
  }

  // Blocked topics — auto-generates restriction text
  if (config.blockedTopics && config.blockedTopics.length > 0) {
    const topicList = config.blockedTopics.map(t => `- ${t}`).join('\n');
    parts.push(
      `## CONFIDENTIAL — DO NOT DISCUSS IN THIS GROUP\n` +
      `The following topics are CONFIDENTIAL and must NOT be mentioned, referenced, or discussed in this group under any circumstances:\n` +
      `${topicList}\n\n` +
      `If asked about any of these, say you cannot discuss them in this context. Do not confirm or deny their existence. Do not hint at them.`
    );
  }

  if (parts.length === 0) return '';
  return '\n\n' + parts.join('\n\n');
}

/**
 * Get all registered group JIDs (for diagnostics).
 */
export function getRegisteredGroups() {
  ensureLoaded();
  return Object.entries(registry.groups || {}).map(([jid, config]) => ({
    jid,
    label: config.label,
    blockedTopics: config.blockedTopics || [],
    hasConfidentialityPrompt: !!config.confidentialityPrompt,
  }));
}

/**
 * Force reload (used by tests or admin).
 */
export function reloadGroupRegistry() {
  loadRegistry();
}
