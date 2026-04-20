// src/group-members.js — Per-group member register.
//
// Pins each speaker (human or bot) to a stable JID key so downstream
// consumers (dream mode, already-answered heuristic, transcripts) stop
// relying on `pushName`, which drifts across client updates and between
// bot/human-operator identities. Design from the 2026-04-19 LQCore
// identity-slippage investigation, now generalised to every group.
//
// Shape on disk (data/runtime/group-members.json):
//   { "groups": { "<chatJid>": { "<senderJid>": MemberRecord } } }
//
// MemberRecord:
//   {
//     canonicalName: string,         // display name (first pushName seen, updatable)
//     kind: 'human'|'bot-self'|'bot-other'|'unknown',
//     operator?: string,             // senderJid of the human operator (bots only)
//     aliases: string[],             // other pushNames seen for this JID
//     firstSeen: string,             // ISO timestamp
//     lastSeen: string,              // ISO timestamp
//     notes?: string
//   }
//
// Writes are buffered: `observeMember` sets a dirty flag and schedules a
// flush 30s later, so a bursty group conversation doesn't fsync on every
// message. Reads are snapshot-based and hot-reload every 5 minutes.
//
// `resolveSpeaker` is the accuracy-enhancing lookup for downstream
// consumers. When called with an unknown (chatJid, senderJid) pair, it
// writes one JSONL line to data/runtime/pending-members/pending-<date>
// .jsonl for later human review — the quarantine path from the design.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import logger from './logger.js';
import { runtimePath } from './overnight/paths.js';

const REGISTER_FILE = runtimePath('group-members.json');
const PENDING_DIR = join('data', 'runtime', 'pending-members');
const RELOAD_INTERVAL_MS = 300_000; // 5 min
const FLUSH_DEBOUNCE_MS = 30_000;   // 30s — bursty chat shouldn't thrash disk

const VALID_KINDS = new Set(['human', 'bot-self', 'bot-other', 'unknown']);
const MAX_ALIASES = 8;

let register = { groups: {} };
let lastLoadedAt = 0;
let dirty = false;
let flushTimer = null;
let quarantinedThisProcess = new Set(); // chatJid|senderJid — dedup quarantine writes per process

// ── I/O ─────────────────────────────────────────────────────────────────

function loadRegister() {
  try {
    if (!existsSync(REGISTER_FILE)) return;
    const raw = JSON.parse(readFileSync(REGISTER_FILE, 'utf-8'));
    register = raw && typeof raw === 'object' && raw.groups ? raw : { groups: {} };
    lastLoadedAt = Date.now();
    const groupCount = Object.keys(register.groups).length;
    const memberCount = Object.values(register.groups).reduce((n, g) => n + Object.keys(g).length, 0);
    if (memberCount > 0) {
      logger.info({ groups: groupCount, members: memberCount }, 'group-members loaded');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'group-members: failed to load');
  }
}

function ensureLoaded() {
  if (Date.now() - lastLoadedAt > RELOAD_INTERVAL_MS) loadRegister();
}

function saveRegister() {
  try {
    mkdirSync(dirname(REGISTER_FILE), { recursive: true });
    writeFileSync(REGISTER_FILE, JSON.stringify(register, null, 2));
    lastLoadedAt = Date.now();
    dirty = false;
  } catch (err) {
    logger.error({ err: err.message }, 'group-members: failed to save');
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) saveRegister();
  }, FLUSH_DEBOUNCE_MS);
  // Don't keep the event loop alive just for the flush.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** Force-flush any pending write. Call on shutdown if wired. */
export function flushGroupMembers() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirty) saveRegister();
}

loadRegister();

// ── Helpers ─────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function isValidJid(jid) {
  return typeof jid === 'string' && jid.length > 0 && jid.includes('@');
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function ensureGroup(chatJid) {
  if (!register.groups[chatJid]) register.groups[chatJid] = {};
  return register.groups[chatJid];
}

function writeQuarantineLine(chatJid, senderJid, pushName) {
  const dedupKey = `${chatJid}|${senderJid}`;
  if (quarantinedThisProcess.has(dedupKey)) return;
  quarantinedThisProcess.add(dedupKey);
  try {
    mkdirSync(PENDING_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = join(PENDING_DIR, `pending-${date}.jsonl`);
    const line = JSON.stringify({
      timestamp: nowIso(),
      chatJid,
      senderJid,
      pushName: pushName || null,
    }) + '\n';
    appendFileSync(file, line);
  } catch (err) {
    logger.warn({ err: err.message, chatJid, senderJid }, 'group-members: quarantine write failed');
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Record that `senderJid` was seen in `chatJid` with `pushName`. Creates a
 * new record on first sight, updates lastSeen and aliases otherwise.
 *
 * Skips silently when any of the inputs is missing or when chatJid is not
 * a group JID — DM members aren't tracked here (they're implied by the
 * owner config).
 *
 * @param {string} chatJid WhatsApp group JID (e.g. "120363...@g.us")
 * @param {string} senderJid Speaker JID (e.g. "447966523191@s.whatsapp.net")
 * @param {string} pushName Raw pushName from Baileys, may be null/"Unknown"
 * @param {object} [opts]
 * @param {boolean} [opts.isBotSelf] true when the message was `fromMe` — seeds kind='bot-self'
 */
export function observeMember(chatJid, senderJid, pushName, opts = {}) {
  if (!isGroupJid(chatJid) || !isValidJid(senderJid)) return;
  ensureLoaded();

  const group = ensureGroup(chatJid);
  const existing = group[senderJid];
  const clean = typeof pushName === 'string' && pushName.trim() && pushName !== 'Unknown'
    ? pushName.trim()
    : null;
  const now = nowIso();

  if (!existing) {
    group[senderJid] = {
      canonicalName: clean || senderJid.split('@')[0],
      kind: opts.isBotSelf ? 'bot-self' : 'unknown',
      aliases: [],
      firstSeen: now,
      lastSeen: now,
    };
    dirty = true;
    scheduleFlush();
    return;
  }

  let changed = false;
  if (existing.lastSeen !== now) {
    existing.lastSeen = now;
    changed = true;
  }
  // Merge a new pushName into aliases if it differs from canonicalName and
  // isn't already tracked. Cap alias list to keep the file tidy.
  if (clean && clean !== existing.canonicalName) {
    existing.aliases = Array.isArray(existing.aliases) ? existing.aliases : [];
    if (!existing.aliases.includes(clean) && existing.aliases.length < MAX_ALIASES) {
      existing.aliases.push(clean);
      changed = true;
    }
  }
  // Upgrade kind if we learn new information — e.g. a sender later
  // identified as bot-self via fromMe.
  if (opts.isBotSelf && existing.kind !== 'bot-self') {
    existing.kind = 'bot-self';
    changed = true;
  }
  if (changed) {
    dirty = true;
    scheduleFlush();
  }
}

/**
 * Lookup the canonical identity for a speaker. Returns the stored record
 * when available, a quarantined fallback when not. Always returns a
 * non-null object — callers can rely on `canonicalName` and `kind`.
 *
 * Source values:
 *   - 'register':   JID matched a stored record
 *   - 'quarantine': JID was unknown; a line was appended to pending-members
 *   - 'fallback':   input was invalid (no senderJid, DM chat, etc.)
 *
 * @param {string} chatJid
 * @param {string} senderJid
 * @param {string} [pushName]
 * @returns {{canonicalName: string, kind: string, operator: string|null, aliases: string[], source: string}}
 */
export function resolveSpeaker(chatJid, senderJid, pushName = null) {
  if (!isGroupJid(chatJid) || !isValidJid(senderJid)) {
    return {
      canonicalName: pushName || 'Unknown',
      kind: 'unknown',
      operator: null,
      aliases: [],
      source: 'fallback',
    };
  }
  ensureLoaded();
  const group = register.groups[chatJid];
  const rec = group && group[senderJid];
  if (rec) {
    return {
      canonicalName: rec.canonicalName,
      kind: rec.kind || 'unknown',
      operator: rec.operator || null,
      aliases: Array.isArray(rec.aliases) ? rec.aliases.slice() : [],
      source: 'register',
    };
  }
  writeQuarantineLine(chatJid, senderJid, pushName);
  return {
    canonicalName: pushName || senderJid.split('@')[0],
    kind: 'unknown',
    operator: null,
    aliases: [],
    source: 'quarantine',
  };
}

/** Return the full member map for a group (snapshot copy). */
export function getMembers(chatJid) {
  ensureLoaded();
  const group = register.groups[chatJid];
  if (!group) return {};
  return JSON.parse(JSON.stringify(group));
}

/** Return one member record or null. */
export function getMember(chatJid, senderJid) {
  ensureLoaded();
  const group = register.groups[chatJid];
  if (!group || !group[senderJid]) return null;
  return JSON.parse(JSON.stringify(group[senderJid]));
}

/**
 * Write or merge a member record. Used by admin tooling to promote
 * kind='unknown' to 'human'/'bot-other' and to link bots to operators.
 * Partial updates merge; pass explicit fields to clear.
 */
export function setMember(chatJid, senderJid, patch) {
  if (!isGroupJid(chatJid) || !isValidJid(senderJid) || !patch || typeof patch !== 'object') {
    throw new Error('setMember: chatJid, senderJid, and a patch object are required');
  }
  if (patch.kind !== undefined && !VALID_KINDS.has(patch.kind)) {
    throw new Error(`setMember: invalid kind "${patch.kind}" — must be one of ${[...VALID_KINDS].join(', ')}`);
  }
  ensureLoaded();
  const group = ensureGroup(chatJid);
  const existing = group[senderJid] || {
    canonicalName: senderJid.split('@')[0],
    kind: 'unknown',
    aliases: [],
    firstSeen: nowIso(),
    lastSeen: nowIso(),
  };
  const merged = { ...existing, ...patch };
  if (!Array.isArray(merged.aliases)) merged.aliases = [];
  group[senderJid] = merged;
  dirty = true;
  saveRegister(); // admin edits flush immediately
}

/** Force reload from disk — used by tests. */
export function reloadGroupMembers() {
  lastLoadedAt = 0;
  quarantinedThisProcess = new Set();
  loadRegister();
}

/** Diagnostics: member counts per group. */
export function getMemberStats() {
  ensureLoaded();
  const out = {};
  for (const [jid, members] of Object.entries(register.groups)) {
    const byKind = { human: 0, 'bot-self': 0, 'bot-other': 0, unknown: 0 };
    for (const rec of Object.values(members)) {
      const k = VALID_KINDS.has(rec.kind) ? rec.kind : 'unknown';
      byKind[k] += 1;
    }
    out[jid] = { total: Object.keys(members).length, byKind };
  }
  return out;
}
