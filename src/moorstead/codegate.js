// src/moorstead/codegate.js
// Mechanical safety gate for the Moorstead auto-coder.
// Pure — no I/O, no side effects. Never throws.
//
// Usage:
//   import { classifyChange } from './src/moorstead/codegate.js';
//   const result = classifyChange(gitNumstatOutput, opts);
//
// Returns: { verdict: 'green'|'amber'|'red', reasons: string[], stats: { files, added, deleted, paths: string[] } }

// ── Constants (module-level so they're auditable + overridable via opts) ─────

/**
 * Exact file paths that are hard-locked (never deployable).
 * Changing these requires an explicit opt-in via opts.locked.
 */
export const DEFAULT_LOCKED_EXACT = Object.freeze([
  // Terrain / world generators & global look
  'src/worldgen.js',
  'src/geography.js',
  'src/noise.js',
  'src/sky.js',
  'src/landmarks.js',
  'src/rails.js',
  // Core data / protocol / save format
  'src/defs.js',
  'src/multiplayer.js',
  'src/player.js',
  // Build / deps / config / CI / deploy
  'package.json',
  'package-lock.json',
]);

/**
 * Glob-style patterns (applied via RegExp) that match locked paths.
 * These cover the auth/admin surface and build/deploy infrastructure.
 */
export const DEFAULT_LOCKED_PATTERNS = Object.freeze([
  // Auth / security surface — any path containing these words
  /(auth|account|login|warden|admin|token|secret|password|cred)/i,
  // Vite / vercel / deploy configs
  /vite\.config\./i,
  /vercel\.json$/i,
  /\.vercelignore$/i,
  // Deploy / CI infrastructure directories
  /^deploy\//i,
  /^\.github\//i,
  /^scripts\//i,
  // Dotfiles at repo root (anything starting with a dot that has no directory separator)
  /^\.[^/]+$/,
  // Service unit files
  /\.service$/i,
  // Python files (runner scripts live in worldsvc — these must not be touched from here)
  /\.py$/i,
  // worldsvc / server directories
  /^worldsvc\//i,
  /^server\//i,
  // server or worldsvc at any depth
  /\/worldsvc\//i,
  /\/server\//i,
]);

/**
 * "Content-only" allowlist for GREEN verdict.
 * A change touches only these files (or new files under src/) → eligible for green.
 */
export const DEFAULT_GREEN_ALLOWLIST = Object.freeze([
  'src/entities.js',
  'src/npc.js',
]);

/** Default caps */
export const DEFAULT_MAX_FILES = 4;
export const DEFAULT_MAX_LINES = 150;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse one line of `git diff --numstat` output.
 * Format: "<added>\t<deleted>\t<path>" where added/deleted may be "-" for binary.
 * Returns null if unparseable.
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // numstat lines: <added>\t<deleted>\t<path>
  // added/deleted may be '-' for binary files
  const m = trimmed.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
  if (!m) return null;
  const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
  const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10);
  const path = m[3];
  return { added, deleted, path };
}

/**
 * Returns true if the given path matches any locked exact file or pattern.
 */
function isLocked(path, lockedExact, lockedPatterns) {
  if (lockedExact.includes(path)) return true;
  for (const re of lockedPatterns) {
    if (re.test(path)) return true;
  }
  return false;
}

/**
 * Returns true if the path is in the green allowlist, or matches the "new src/ file" pattern.
 *
 * "New files under src/" are green-eligible per spec. Since git diff --numstat does not
 * distinguish new vs modified files, we use a conservative heuristic: a path is treated as
 * a "new content file" if it is directly under src/ (not a subdirectory) AND its basename
 * does not match any known existing game-file stem. The known existing stems are the locked
 * files + the explicit amber-only stems (quests, milestones, ui, train, textures, etc.).
 *
 * In practice the EVO runner enforces a stricter check; this gate is a first-pass envelope.
 * Unknown src/*.js files (not in the explicit allowlist) land in amber unless the caller
 * opts them into the green allowlist via opts.greenAllowlist.
 */
function isGreenSafe(path, greenAllowlist) {
  if (greenAllowlist.includes(path)) return true;
  return false;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Classify a `git diff --numstat` output string.
 *
 * @param {string} numstat - Raw output of `git diff --numstat <base>..<branch>`
 * @param {object} [opts]
 * @param {number}   [opts.maxFiles]       - Override DEFAULT_MAX_FILES
 * @param {number}   [opts.maxLines]       - Override DEFAULT_MAX_LINES
 * @param {string[]} [opts.lockedExact]    - Override DEFAULT_LOCKED_EXACT (replaces, not merges)
 * @param {RegExp[]} [opts.lockedPatterns] - Override DEFAULT_LOCKED_PATTERNS (replaces, not merges)
 * @param {string[]} [opts.greenAllowlist] - Override DEFAULT_GREEN_ALLOWLIST (replaces, not merges)
 *
 * @returns {{ verdict: 'green'|'amber'|'red', reasons: string[], stats: { files: number, added: number, deleted: number, paths: string[] } }}
 */
export function classifyChange(numstat, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const lockedExact = opts.lockedExact ?? DEFAULT_LOCKED_EXACT;
  const lockedPatterns = opts.lockedPatterns ?? DEFAULT_LOCKED_PATTERNS;
  const greenAllowlist = opts.greenAllowlist ?? DEFAULT_GREEN_ALLOWLIST;

  // ── Parse ────────────────────────────────────────────────────────────────

  const reasons = [];
  const paths = [];
  let totalAdded = 0;
  let totalDeleted = 0;

  if (!numstat || typeof numstat !== 'string' || !numstat.trim()) {
    return {
      verdict: 'red',
      reasons: ['no parseable diff — numstat input is empty or invalid'],
      stats: { files: 0, added: 0, deleted: 0, paths: [] },
    };
  }

  const lines = numstat.split('\n');
  const parsed = [];
  let unparseable = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) {
      unparseable++;
      continue;
    }
    parsed.push(entry);
    paths.push(entry.path);
    totalAdded += entry.added;
    totalDeleted += entry.deleted;
  }

  if (parsed.length === 0) {
    return {
      verdict: 'red',
      reasons: ['no parseable diff — all lines failed to parse (garbage input?)'],
      stats: { files: 0, added: 0, deleted: 0, paths: [] },
    };
  }

  const stats = { files: parsed.length, added: totalAdded, deleted: totalDeleted, paths };

  // ── RED checks ────────────────────────────────────────────────────────────

  // 1. Locked paths (hard block)
  const lockedPaths = paths.filter(p => isLocked(p, lockedExact, lockedPatterns));
  if (lockedPaths.length > 0) {
    for (const p of lockedPaths) {
      reasons.push(`locked path: ${p}`);
    }
    reasons.push('locked files are hard-blocked — never deployable via auto-coder');
    return { verdict: 'red', reasons, stats };
  }

  // 2. File count cap
  if (stats.files > maxFiles) {
    reasons.push(`too many files changed: ${stats.files} (max ${maxFiles})`);
    return { verdict: 'red', reasons, stats };
  }

  // 3. Line count cap
  const totalLines = totalAdded + totalDeleted;
  if (totalLines > maxLines) {
    reasons.push(`too many lines changed: ${totalLines} (max ${maxLines}, ${totalAdded} added + ${totalDeleted} deleted)`);
    return { verdict: 'red', reasons, stats };
  }

  // ── GREEN check ───────────────────────────────────────────────────────────
  // All paths must be green-safe AND files ≤ 2 AND lines ≤ 60

  const nonGreenPaths = paths.filter(p => !isGreenSafe(p, greenAllowlist));
  const isWithinGreenCaps = stats.files <= 2 && totalLines <= 60;

  if (nonGreenPaths.length === 0 && isWithinGreenCaps) {
    reasons.push(`${stats.files} file(s) changed, ${totalLines} line(s) — within green envelope (≤2 files, ≤60 lines, content-only paths)`);
    return { verdict: 'green', reasons, stats };
  }

  // ── AMBER ─────────────────────────────────────────────────────────────────
  // Additive content change, within caps, no locked paths — requires explicit confirm

  const amberReasons = [];
  if (!isWithinGreenCaps) {
    amberReasons.push(`${stats.files} file(s), ${totalLines} line(s) — exceeds green caps (≤2 files, ≤60 lines) but within amber limits`);
  }
  if (nonGreenPaths.length > 0) {
    amberReasons.push(`path(s) outside green allowlist: ${nonGreenPaths.join(', ')}`);
  }
  amberReasons.push('requires explicit owner confirm via moorstead_code_confirm');
  reasons.push(...amberReasons);

  return { verdict: 'amber', reasons, stats };
}
