// Soul system — self-recode with guardrails
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

// --- Internal helpers ---

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function loadSoul() {
  ensureDataDir();
  const defaultSoul = { personality: '', preferences: '', context: '', custom: '' };
  if (!existsSync(SOUL_FILE)) {
    writeFileSync(SOUL_FILE, JSON.stringify(defaultSoul, null, 2));
    return defaultSoul;
  }
  try {
    return JSON.parse(readFileSync(SOUL_FILE, 'utf-8'));
  } catch {
    writeFileSync(SOUL_FILE, JSON.stringify(defaultSoul, null, 2));
    return defaultSoul;
  }
}

function loadPending() {
  if (!existsSync(PENDING_FILE)) return null;
  try { return JSON.parse(readFileSync(PENDING_FILE, 'utf-8')); } catch { return null; }
}

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')); } catch { return []; }
}

function totalLength(soul, overrideSection, overrideContent) {
  let total = 0;
  for (const section of VALID_SECTIONS) {
    if (section === overrideSection) {
      total += (overrideContent || '').length;
    } else {
      total += (soul[section] || '').length;
    }
  }
  return total;
}

// --- Exported functions ---

export async function soulRead({ section }) {
  const soul = loadSoul();

  if (section) {
    if (!VALID_SECTIONS.includes(section)) {
      return `Invalid section: "${section}". Valid sections: ${VALID_SECTIONS.join(', ')}`;
    }
    return `**${section}:** ${soul[section] || '(empty)'}`;
  }

  const lines = VALID_SECTIONS.map(
    (s) => `**${s}:** ${soul[s] || '(empty)'}`,
  );
  return lines.join('\n');
}

export async function soulPropose({ section, content, reason }) {
  // Validate section
  if (!VALID_SECTIONS.includes(section)) {
    return `Invalid section: "${section}". Valid sections: ${VALID_SECTIONS.join(', ')}`;
  }

  // Validate content length
  if (content.length > MAX_SECTION_LENGTH) {
    return `Content too long: ${content.length} chars (max ${MAX_SECTION_LENGTH}).`;
  }

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(content)) {
      return 'Blocked: content matches a guardrail override pattern. Soul updates cannot modify safety rules.';
    }
  }

  // Check total length
  const soul = loadSoul();
  const projectedTotal = totalLength(soul, section, content);
  if (projectedTotal > MAX_TOTAL_LENGTH) {
    return `Total soul size would be ${projectedTotal} chars (max ${MAX_TOTAL_LENGTH}). Shorten content or clear other sections first.`;
  }

  // Write pending
  const pending = {
    section,
    content,
    reason: reason || '(no reason given)',
    previous: soul[section] || '',
    timestamp: new Date().toISOString(),
  };
  ensureDataDir();
  writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));

  // Return diff
  const current = soul[section] || '(empty)';
  return [
    `Proposed change to **${section}**:`,
    ``,
    `**Current:** ${current}`,
    `**Proposed:** ${content}`,
    `**Reason:** ${pending.reason}`,
    ``,
    `Use soul_confirm to apply, or propose again to overwrite.`,
  ].join('\n');
}

export async function soulConfirm() {
  const pending = loadPending();
  if (!pending) {
    return 'No pending soul change to confirm.';
  }

  const soul = loadSoul();

  // Backup current soul
  ensureDataDir();
  writeFileSync(BACKUP_FILE, JSON.stringify(soul, null, 2));

  // Apply change
  soul[pending.section] = pending.content;
  writeFileSync(SOUL_FILE, JSON.stringify(soul, null, 2));

  // Append to history (keep last 50)
  const history = loadHistory();
  history.push({
    section: pending.section,
    content: pending.content,
    previous: pending.previous,
    reason: pending.reason,
    timestamp: pending.timestamp,
    confirmedAt: new Date().toISOString(),
  });
  while (history.length > 50) {
    history.shift();
  }
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  // Delete pending
  unlinkSync(PENDING_FILE);

  return `Soul updated: **${pending.section}** set to "${pending.content}".`;
}

export function getSoulData() {
  const soul = loadSoul();
  const pending = loadPending();
  const history = loadHistory();
  return { soul, pending, history };
}

export function getSoulPromptFragment() {
  const soul = loadSoul();
  const lines = [];

  for (const section of VALID_SECTIONS) {
    if (soul[section]) {
      lines.push(`**${section}:** ${soul[section]}`);
    }
  }

  if (lines.length === 0) return '';

  return '\n\n## Learned preferences and context (self-updated)\n' + lines.join('\n');
}

export function resetSoul() {
  ensureDataDir();
  const defaultSoul = { personality: '', preferences: '', context: '', custom: '' };
  writeFileSync(SOUL_FILE, JSON.stringify(defaultSoul, null, 2));

  if (existsSync(PENDING_FILE)) {
    unlinkSync(PENDING_FILE);
  }

  return 'Soul reset to defaults.';
}
