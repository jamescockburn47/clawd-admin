// Soul system — earned learning through observation, with severity-gated promotion
import { readFile, writeFile, mkdir } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', '..', 'data');
const SOUL_FILE = join(DATA_DIR, 'soul.json');
const OBS_FILE = join(DATA_DIR, 'soul_observations.json');
const BACKUP_FILE = join(DATA_DIR, 'soul_backup.json');

const VALID_SECTIONS = ['people', 'patterns', 'lessons', 'boundaries'];
const MAX_ENTRIES_PER_SECTION = 12;
const OBS_DECAY_DAYS = 14;

// Severity thresholds — how many occurrences before promotion to soul
const SEVERITY_THRESHOLDS = {
  routine: 3,    // normal observations need 3 separate days
  corrective: 2, // error corrections need 2
  critical: 1,   // significant events promote immediately
};

const BLOCKED_PATTERNS = [
  /\b(ignore|override|disregard|bypass|disable|remove|delete|forget)\b.*\b(guardrail|rule|instruction|safety|constraint|restriction|limitation|guideline)\b/i,
  /\b(guardrail|rule|instruction|safety|constraint|restriction)\b.*\b(ignore|override|disregard|bypass|disable|remove|delete|forget)\b/i,
  /\byou (are|must|should|can) now\b.*\b(ignore|override|send|delete)\b/i,
  /\bsystem prompt\b.*\b(change|modify|replace|rewrite|override)\b/i,
  /\b(always|never)\b.*\b(send email|skip confirmation|skip approval)\b/i,
];

const DEFAULT_SOUL = { people: [], patterns: [], lessons: [], boundaries: [] };

// ── Helpers ─────────────────────────────────────────────────────────────────

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function safeParseSync(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch { return fallback; }
}

function loadJSONSync(path, fallback) {
  if (!existsSync(path)) return fallback;
  return safeParseSync(readFileSync(path, 'utf-8'), fallback);
}

async function loadSoul() {
  await ensureDataDir();
  const soul = await loadJSON(SOUL_FILE, null);
  if (soul && Array.isArray(soul.people)) return soul;
  // Migration from old format or missing file
  const migrated = { ...DEFAULT_SOUL };
  await writeFile(SOUL_FILE, JSON.stringify(migrated, null, 2));
  logger.info('soul migrated to new array format');
  return migrated;
}

async function saveSoul(soul) {
  await ensureDataDir();
  await writeFile(SOUL_FILE, JSON.stringify(soul, null, 2));
}

async function loadObservations() {
  return loadJSON(OBS_FILE, { observations: [] });
}

async function saveObservations(data) {
  await ensureDataDir();
  await writeFile(OBS_FILE, JSON.stringify(data, null, 2));
}

function isBlocked(text) {
  return BLOCKED_PATTERNS.some(p => p.test(text));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Soul tools (async — called via Claude tool dispatch) ────────────────────

export async function soulRead({ section }) {
  const soul = await loadSoul();

  if (section) {
    if (!VALID_SECTIONS.includes(section)) {
      return `Invalid section: "${section}". Valid: ${VALID_SECTIONS.join(', ')}`;
    }
    const entries = soul[section] || [];
    if (entries.length === 0) return `**${section}:** (empty)`;
    return `**${section}:**\n` + entries.map((e, i) =>
      `${i + 1}. ${e.text} [${e.source}, ${e.created.slice(0, 10)}]`
    ).join('\n');
  }

  return VALID_SECTIONS.map(s => {
    const entries = soul[s] || [];
    if (entries.length === 0) return `**${s}:** (empty)`;
    return `**${s}:**\n` + entries.map((e, i) =>
      `${i + 1}. ${e.text} [${e.source}, ${e.created.slice(0, 10)}]`
    ).join('\n');
  }).join('\n\n');
}

/**
 * Direct soul entry — bypasses observation buffer.
 * Used when James explicitly tells Clawd something, or mid-conversation learning.
 */
export async function soulLearn({ section, text }) {
  if (!VALID_SECTIONS.includes(section)) {
    return `Invalid section: "${section}". Valid: ${VALID_SECTIONS.join(', ')}`;
  }
  if (!text || text.length < 5) return 'Text too short.';
  if (text.length > 200) return `Text too long: ${text.length} chars (max 200).`;
  if (isBlocked(text)) return 'Blocked: content matches a guardrail override pattern.';

  const soul = await loadSoul();
  const entries = soul[section] || [];

  // Check for near-duplicate
  const lower = text.toLowerCase();
  const isDup = entries.some(e => e.text.toLowerCase() === lower);
  if (isDup) return `Already learned: "${text}"`;

  entries.push({
    text,
    source: 'manual',
    created: new Date().toISOString(),
  });

  // Evict oldest if over limit
  while (entries.length > MAX_ENTRIES_PER_SECTION) entries.shift();
  soul[section] = entries;

  await saveSoul(soul);
  logger.info({ section, text }, 'soul entry added (direct)');
  return `Learned: "${text}" added to ${section}.`;
}

/**
 * Remove a soul entry by section and 1-based index.
 */
export async function soulForget({ section, index }) {
  if (!VALID_SECTIONS.includes(section)) {
    return `Invalid section: "${section}". Valid: ${VALID_SECTIONS.join(', ')}`;
  }

  const soul = await loadSoul();
  const entries = soul[section] || [];
  const idx = index - 1; // 1-based to 0-based

  if (idx < 0 || idx >= entries.length) {
    return `Invalid index ${index}. ${section} has ${entries.length} entries.`;
  }

  const removed = entries.splice(idx, 1)[0];
  soul[section] = entries;
  await saveSoul(soul);
  logger.info({ section, index, text: removed.text }, 'soul entry removed');
  return `Forgot: "${removed.text}" removed from ${section}.`;
}

/**
 * Legacy propose — still used for explicit user-initiated proposals.
 */
export async function soulPropose({ section, content, reason }) {
  // Redirect to soulLearn — the old propose/confirm flow is replaced
  return soulLearn({ section, text: content });
}

/**
 * Legacy confirm — no longer needed but kept for backwards compat.
 */
export async function soulConfirm() {
  return 'The soul system no longer uses propose/confirm. Use soul_learn to add entries directly, or soul_forget to remove them.';
}

// ── Observation buffer (for dream mode) ─────────────────────────────────────

/**
 * Add an observation from dream mode. Checks for repeats, promotes when threshold met.
 * Returns { promoted: bool, text: string, section: string }
 */
export async function addObservation({ text, section, severity = 'routine' }) {
  if (!VALID_SECTIONS.includes(section)) {
    return { error: `Invalid section: ${section}` };
  }
  if (isBlocked(text)) {
    return { error: 'Blocked by guardrail pattern' };
  }

  const data = await loadObservations();
  const todayStr = today();
  const threshold = SEVERITY_THRESHOLDS[severity] || 3;

  // Find existing observation (fuzzy match — same section + similar text)
  const lower = text.toLowerCase();
  let existing = data.observations.find(o =>
    o.section === section && o.text.toLowerCase() === lower && !o.promoted
  );

  if (existing) {
    // Don't count same day twice
    if (!existing.occurrences.includes(todayStr)) {
      existing.occurrences.push(todayStr);
    }
  } else {
    existing = {
      text,
      section,
      severity,
      first_seen: todayStr,
      occurrences: [todayStr],
      promoted: false,
    };
    data.observations.push(existing);
  }

  // Check promotion threshold
  let promoted = false;
  if (existing.occurrences.length >= threshold && !existing.promoted) {
    // Promote to soul
    const soul = await loadSoul();
    const entries = soul[section] || [];

    // Check for duplicate in soul
    const isDup = entries.some(e => e.text.toLowerCase() === lower);
    if (!isDup) {
      entries.push({
        text,
        source: `dream_${todayStr}`,
        created: new Date().toISOString(),
      });
      while (entries.length > MAX_ENTRIES_PER_SECTION) entries.shift();
      soul[section] = entries;
      await saveSoul(soul);
      logger.info({ section, text, severity, occurrences: existing.occurrences.length }, 'observation promoted to soul');
    }

    existing.promoted = true;
    promoted = true;
  }

  // Decay old unpromoted observations
  const cutoff = Date.now() - (OBS_DECAY_DAYS * 86400000);
  data.observations = data.observations.filter(o => {
    if (o.promoted) return true; // keep promoted for history
    const lastOccurrence = new Date(o.occurrences[o.occurrences.length - 1]).getTime();
    return lastOccurrence > cutoff;
  });

  await saveObservations(data);
  return { promoted, text, section, occurrences: existing.occurrences.length, threshold };
}

/**
 * Get current observation buffer state (for dashboard / debugging).
 */
export async function getObservationState() {
  return loadObservations();
}

// ── Sync API for prompt-building (files are tiny <2KB) ──────────────────────

export function getSoulData() {
  const soul = loadJSONSync(SOUL_FILE, { ...DEFAULT_SOUL });
  const observations = loadJSONSync(OBS_FILE, { observations: [] });
  return { soul, observations };
}

export function getSoulPromptFragment() {
  const soul = loadJSONSync(SOUL_FILE, { ...DEFAULT_SOUL });

  const sections = [];

  for (const section of VALID_SECTIONS) {
    const entries = soul[section] || [];
    if (entries.length === 0) continue;

    const label = {
      people: 'People I know',
      patterns: 'Patterns I\'ve noticed',
      lessons: 'Lessons from experience',
      boundaries: 'Boundaries I\'ve learned',
    }[section];

    const lines = entries.map(e => `- ${e.text} [${e.created.slice(0, 10)}]`);
    sections.push(`**${label}:**\n${lines.join('\n')}`);
  }

  if (sections.length === 0) return '';
  return '\n\n## What I\'ve learned from interactions\n' + sections.join('\n\n');
}

export async function resetSoul() {
  await ensureDataDir();
  await writeFile(SOUL_FILE, JSON.stringify({ ...DEFAULT_SOUL }, null, 2));
  await writeFile(OBS_FILE, JSON.stringify({ observations: [] }, null, 2));
  return 'Soul and observation buffer reset to defaults.';
}
