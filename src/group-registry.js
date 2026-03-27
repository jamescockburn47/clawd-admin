// src/group-registry.js — Per-group security levels and content restrictions
// Maps WhatsApp group JIDs to security levels (1-10) and optional extras.
// Data lives in data/group-registry.json, hot-reloaded every 5 minutes.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const REGISTRY_FILE = join('data', 'group-registry.json');
const RELOAD_INTERVAL_MS = 300_000; // 5 minutes

let registry = { groups: {} };
let lastLoadedAt = 0;

// ── SECURITY LEVEL DEFINITIONS (1-10) ──────────────────────────────────────
// Each level defines cumulative restrictions (higher = more restricted).
// Prompt text is generated from the level, not stored per-group.

const SECURITY_LEVELS = {
  1: {
    name: 'Open',
    description: 'No restrictions. Full access, like a DM.',
    restrictions: '',
  },
  2: {
    name: 'Relaxed',
    description: 'Block personal admin tools only (calendar, email, todos, travel).',
    restrictions:
      `Personal admin tools (calendar, email, todos, travel) are NOT available in this group. ` +
      `If asked, say those features are only available in DMs with James.`,
  },
  3: {
    name: 'Standard',
    description: 'Block personal admin + personal life details.',
    restrictions:
      `Personal admin tools (calendar, email, todos, travel) are NOT available in this group. ` +
      `Do NOT mention James's personal life: family, children, partner, personal schedule, travel plans, home location, or domestic matters. ` +
      `If asked, say those are private.`,
  },
  4: {
    name: 'Professional',
    description: 'Standard + block work details (employer, cases, clients).',
    restrictions:
      `Personal admin tools are NOT available. ` +
      `Do NOT discuss: James's personal life, family, schedule, travel. ` +
      `Do NOT discuss: James's employer, specific cases, client names, or work matters unless James raises them first. ` +
      `If asked, say you cannot discuss those topics here.`,
  },
  5: {
    name: 'Guarded',
    description: 'Professional + limit self-disclosure to general capabilities only.',
    restrictions:
      `Personal admin tools are NOT available. ` +
      `Do NOT discuss: James's personal life, family, schedule, travel, employer, cases, clients. ` +
      `When discussing yourself: describe general capabilities only (you are an AI assistant). ` +
      `Do NOT volunteer specific architecture details, model names, hardware specs, or IP addresses unless directly asked. ` +
      `Keep self-description high-level: "I use a mix of local and cloud AI models."`,
  },
  6: {
    name: 'Restricted',
    description: 'Guarded + block all project names and James\'s IP.',
    restrictions:
      `Personal admin tools are NOT available. ` +
      `Do NOT discuss: James's personal life, family, schedule, travel, employer, cases, clients. ` +
      `Do NOT mention any project names, products, or ventures that James is involved in. ` +
      `When discussing yourself: general capabilities only. No model names, no hardware, no architecture details, no IP addresses, no port numbers. ` +
      `Say "I'm an AI assistant" if pressed. Do not reveal what you run on or where.`,
  },
  7: {
    name: 'Confidential',
    description: 'Restricted + deny knowledge of James\'s other activities entirely.',
    restrictions:
      `Personal admin tools are NOT available. ` +
      `Do NOT discuss ANY of: James's personal life, family, employer, cases, clients, projects, ventures, technical interests, or AI work. ` +
      `Do NOT mention any project names or business activities. ` +
      `Do NOT reveal your architecture, models, hardware, costs, or how you work internally. ` +
      `If asked about any of these, say you cannot discuss them. Do not confirm or deny. ` +
      `Present yourself as a general AI assistant. Nothing more.`,
  },
  8: {
    name: 'Locked',
    description: 'Confidential + no memory references, no overnight learning mentions.',
    restrictions:
      `Personal admin tools are NOT available. ` +
      `Do NOT discuss ANY of: James's personal life, family, employer, cases, clients, projects, ventures. ` +
      `Do NOT reveal your architecture, models, hardware, memory system, dreams, overnight learning, evolution pipeline, or any internal capability. ` +
      `Do NOT reference memories, prior conversations, or things you "remember". ` +
      `Do NOT confirm or deny having memory, learning capability, or self-improvement. ` +
      `You are a simple AI assistant. Respond helpfully to questions. Nothing more.`,
  },
  9: {
    name: 'Stealth',
    description: 'Locked + don\'t acknowledge being James\'s assistant.',
    restrictions:
      `Do NOT use any tools. Do NOT mention James by name or acknowledge being anyone's personal assistant. ` +
      `Do NOT reveal your architecture, memory, learning, models, hardware, projects, or any internal detail. ` +
      `Do NOT reference any prior conversations or memories. ` +
      `You are a general-purpose AI chatbot called Clawd. You assist with general questions. ` +
      `If asked who made you or who you work for, say you are an independent AI assistant. ` +
      `If pressed on technical details, politely decline.`,
  },
  10: {
    name: 'Maximum',
    description: 'Stealth + minimal responses, no opinions, pure factual assistance.',
    restrictions:
      `Do NOT use any tools. Do NOT mention James, do NOT acknowledge being anyone's personal assistant. ` +
      `Do NOT reveal anything about your architecture, memory, learning, models, hardware, or any internal detail. ` +
      `Do NOT reference prior conversations, memories, or context. ` +
      `Do NOT offer opinions, analysis, or personality. ` +
      `You are a basic AI chatbot. Give short, factual answers only. ` +
      `If asked about yourself, say "I'm an AI assistant." Nothing more. ` +
      `If asked anything you cannot answer from general knowledge, say "I don't know."`,
  },
};

// ── REGISTRY I/O ───────────────────────────────────────────────────────────

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

function saveRegistry() {
  try {
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
    lastLoadedAt = Date.now();
  } catch (err) {
    logger.error({ err: err.message }, 'group-registry: failed to save');
    throw err;
  }
}

// Initial load
loadRegistry();

// ── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * Get the config for a specific group. Returns null if not registered.
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
 * Get the security level for a group (defaults to 3 for unregistered groups).
 */
export function getSecurityLevel(chatJid) {
  const config = getGroupConfig(chatJid);
  return config?.securityLevel || 3;
}

/**
 * Get security level metadata.
 */
export function getSecurityLevelInfo(level) {
  return SECURITY_LEVELS[level] || SECURITY_LEVELS[5];
}

/**
 * Build a restriction prompt fragment for a group based on its security level.
 * Returns empty string if level 1 (no restrictions).
 */
export function getGroupRestrictions(chatJid) {
  const config = getGroupConfig(chatJid);
  const level = config?.securityLevel || 3; // default for unregistered groups

  if (level <= 1) return '';

  const parts = [];

  // Security level restrictions
  const levelDef = SECURITY_LEVELS[level];
  if (levelDef && levelDef.restrictions) {
    parts.push(
      `## SECURITY LEVEL ${level} (${levelDef.name.toUpperCase()})\n` +
      levelDef.restrictions
    );
  }

  // Additional blocked topics (optional per-group extras on top of the level)
  if (config?.blockedTopics && config.blockedTopics.length > 0) {
    const topicList = config.blockedTopics.map(t => `- ${t}`).join('\n');
    parts.push(
      `## ADDITIONAL BLOCKED TOPICS\n` +
      `The following topics are CONFIDENTIAL and must NOT be mentioned, referenced, or discussed in this group:\n` +
      `${topicList}\n` +
      `If asked about any of these, say you cannot discuss them. Do not confirm or deny their existence.`
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
    securityLevel: config.securityLevel || 3,
    blockedTopics: config.blockedTopics || [],
  }));
}

/**
 * Set or update config for a group. Persists immediately.
 */
export function setGroupConfig(chatJid, config) {
  ensureLoaded();
  if (!registry.groups) registry.groups = {};
  const existing = registry.groups[chatJid] || {};
  registry.groups[chatJid] = { ...existing, ...config };
  saveRegistry();
  logger.info({ chatJid, label: registry.groups[chatJid].label, securityLevel: registry.groups[chatJid].securityLevel }, 'group-registry: config updated');
}

/**
 * Remove a group from the registry. Persists immediately.
 */
export function removeGroupConfig(chatJid) {
  ensureLoaded();
  if (!registry.groups || !registry.groups[chatJid]) return false;
  delete registry.groups[chatJid];
  saveRegistry();
  logger.info({ chatJid }, 'group-registry: group removed');
  return true;
}

/**
 * Force reload (used by tests or admin).
 */
export function reloadGroupRegistry() {
  loadRegistry();
}

/**
 * Get all security level definitions (for help display).
 */
export function getAllSecurityLevels() {
  return Object.entries(SECURITY_LEVELS).map(([level, def]) => ({
    level: parseInt(level),
    name: def.name,
    description: def.description,
  }));
}
