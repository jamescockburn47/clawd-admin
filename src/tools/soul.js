// Soul system — self-recode with guardrails (async I/O for mutations, sync for reads)
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', '..', 'data');
const SOUL_FILE = join(DATA_DIR, 'soul.json');
const PENDING_FILE = join(DATA_DIR, 'soul_pending.json');
const BACKUP_FILE = join(DATA_DIR, 'soul_backup.json');
const HISTORY_FILE = join(DATA_DIR, 'soul_history.json');

const VALID_SECTIONS = ['personality', 'preferences', 'context', 'custom'];
const MAX_SECTION_LENGTH = 500;
const MAX_TOTAL_LENGTH = 2000;

const BLOCKED_PATTERNS = [
  /\b(ignore|override|disregard|bypass|disable|remove|delete|forget)\b.*\b(guardrail|rule|instruction|safety|constraint|restriction|limitation|guideline)\b/i,
  /\b(guardrail|rule|instruction|safety|constraint|restriction)\b.*\b(ignore|override|disregard|bypass|disable|remove|delete|forget)\b/i,
  /\byou (are|must|should|can) now\b.*\b(ignore|override|send|delete)\b/i,
  /\bsystem prompt\b.*\b(change|modify|replace|rewrite|override)\b/i,
  /\b(always|never)\b.*\b(send email|skip confirmation|skip approval)\b/i,
];

const DEFAULT_SOUL = { personality: '', preferences: '', context: '', custom: '' };

// --- Helpers ---

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function safeParseSync(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data);
  } catch { return fallback; }
}

function loadJSONSync(path, fallback) {
  if (!existsSync(path)) return fallback;
  return safeParseSync(readFileSync(path, 'utf-8'), fallback);
}

async function loadSoul() {
  await ensureDataDir();
  const soul = await loadJSON(SOUL_FILE, null);
  if (soul) return soul;
  await writeFile(SOUL_FILE, JSON.stringify(DEFAULT_SOUL, null, 2));
  return { ...DEFAULT_SOUL };
}

function totalLength(soul, overrideSection, overrideContent) {
  let total = 0;
  for (const section of VALID_SECTIONS) {
    total += (section === overrideSection ? overrideContent : soul[section] || '').length;
  }
  return total;
}

// --- Tool handlers (async — called via Claude tool dispatch) ---

export async function soulRead({ section }) {
  const soul = await loadSoul();

  if (section) {
    if (!VALID_SECTIONS.includes(section)) {
      return `Invalid section: "${section}". Valid sections: ${VALID_SECTIONS.join(', ')}`;
    }
    return `**${section}:** ${soul[section] || '(empty)'}`;
  }

  return VALID_SECTIONS.map((s) => `**${s}:** ${soul[s] || '(empty)'}`).join('\n');
}

export async function soulPropose({ section, content, reason }) {
  if (!VALID_SECTIONS.includes(section)) {
    return `Invalid section: "${section}". Valid sections: ${VALID_SECTIONS.join(', ')}`;
  }

  if (content.length > MAX_SECTION_LENGTH) {
    return `Content too long: ${content.length} chars (max ${MAX_SECTION_LENGTH}).`;
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(content)) {
      return 'Blocked: content matches a guardrail override pattern. Soul updates cannot modify safety rules.';
    }
  }

  const soul = await loadSoul();
  const projectedTotal = totalLength(soul, section, content);
  if (projectedTotal > MAX_TOTAL_LENGTH) {
    return `Total soul size would be ${projectedTotal} chars (max ${MAX_TOTAL_LENGTH}). Shorten content or clear other sections first.`;
  }

  const pending = {
    section,
    content,
    reason: reason || '(no reason given)',
    previous: soul[section] || '',
    timestamp: new Date().toISOString(),
  };
  await ensureDataDir();
  await writeFile(PENDING_FILE, JSON.stringify(pending, null, 2));

  const current = soul[section] || '(empty)';
  return [
    `Proposed change to **${section}**:`,
    '',
    `**Current:** ${current}`,
    `**Proposed:** ${content}`,
    `**Reason:** ${pending.reason}`,
    '',
    'Use soul_confirm to apply, or propose again to overwrite.',
  ].join('\n');
}

export async function soulConfirm() {
  const pending = await loadJSON(PENDING_FILE, null);
  if (!pending) return 'No pending soul change to confirm.';

  const soul = await loadSoul();

  await ensureDataDir();
  await writeFile(BACKUP_FILE, JSON.stringify(soul, null, 2));

  soul[pending.section] = pending.content;
  await writeFile(SOUL_FILE, JSON.stringify(soul, null, 2));

  const history = await loadJSON(HISTORY_FILE, []);
  history.push({
    section: pending.section,
    content: pending.content,
    previous: pending.previous,
    reason: pending.reason,
    timestamp: pending.timestamp,
    confirmedAt: new Date().toISOString(),
  });
  while (history.length > 50) history.shift();
  await writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));

  try { await unlink(PENDING_FILE); } catch {}

  return `Soul updated: **${pending.section}** set to "${pending.content}".`;
}

// --- Sync API for prompt-building and HTTP endpoints (files are tiny <2KB) ---

export function getSoulData() {
  const soul = loadJSONSync(SOUL_FILE, { ...DEFAULT_SOUL });
  const pending = loadJSONSync(PENDING_FILE, null);
  const history = loadJSONSync(HISTORY_FILE, []);
  return { soul, pending, history };
}

export function getSoulPromptFragment() {
  const soul = loadJSONSync(SOUL_FILE, { ...DEFAULT_SOUL });
  const lines = [];

  for (const section of VALID_SECTIONS) {
    if (soul[section]) {
      lines.push(`**${section}:** ${soul[section]}`);
    }
  }

  if (lines.length === 0) return '';
  return '\n\n## Learned preferences and context (self-updated)\n' + lines.join('\n');
}

export async function resetSoul() {
  await ensureDataDir();
  await writeFile(SOUL_FILE, JSON.stringify({ ...DEFAULT_SOUL }, null, 2));
  try { await unlink(PENDING_FILE); } catch {}
  return 'Soul reset to defaults.';
}
