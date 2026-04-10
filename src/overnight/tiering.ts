// src/overnight/tiering.ts — deterministic tier classifier for auto-deploy gates.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.4.
//
// Tier A  config/text/eval-labels/skill additions       → auto-merge on green CI
// Tier B  source changes ≤5 files ≤150 lines, no banned → auto-merge on CI+replay
// Tier C  anything else → opens a DM proposal card, never auto-merges

export const MAX_TIER_B_FILES = 5;
export const MAX_TIER_B_LINES = 150;

/**
 * Files the forge is NEVER allowed to modify via auto-deploy, even when every
 * gate would otherwise pass. This is the code-level banned list (spec §4.4).
 *
 * NOTE: prefix matches use isBannedPath(); exact paths are matched directly.
 */
export const BANNED_FILES: readonly string[] = Object.freeze([
  'src/tasks/forge-orchestrator.js',
  'src/message-handler.js',
  'src/router.js',
  'src/cortex.js',
  'src/memory.js',
  'CLAUDE.md',
  // Prefix markers: any path starting with these hits Tier C.
  'docs/superpowers/',
  'data/runtime/',
]);

export interface DiffSummary {
  filesChanged: string[];
  linesChanged: number;
}

export type Tier = 'A' | 'B' | 'C';

export interface TierClassification {
  tier: Tier;
  reason: string;
}

// Paths that count as "text/config/eval-labels" for Tier A.
const TIER_A_PREFIXES = [
  'data/learned-eval-labels.json',
  'data/prompts/',
  'src/prompt-templates/',
  'src/skills/',
] as const;

const TIER_A_EXTENSIONS = ['.json', '.txt', '.md', '.yaml', '.yml'] as const;

export function isBannedPath(path: string): boolean {
  for (const banned of BANNED_FILES) {
    if (banned.endsWith('/')) {
      if (path.startsWith(banned)) return true;
    } else if (path === banned) {
      return true;
    }
  }
  return false;
}

function isTierAPath(path: string): boolean {
  if (TIER_A_PREFIXES.some((p) => path.startsWith(p))) return true;
  // Top-level text files (e.g. README.md) — but CLAUDE.md is already banned above.
  return TIER_A_EXTENSIONS.some((ext) => path.endsWith(ext)) && !path.startsWith('src/');
}

export function classifyTier(diff: DiffSummary): TierClassification {
  // Banned files always win — check first.
  for (const f of diff.filesChanged) {
    if (isBannedPath(f)) {
      return { tier: 'C', reason: `banned path: ${f}` };
    }
  }

  // Pure Tier A if every file is Tier-A-shaped.
  if (diff.filesChanged.length > 0 && diff.filesChanged.every(isTierAPath)) {
    return { tier: 'A', reason: 'text/config/eval-labels only' };
  }

  // Tier B bounds.
  if (diff.filesChanged.length > MAX_TIER_B_FILES) {
    return {
      tier: 'C',
      reason: `${diff.filesChanged.length} files exceeds max ${MAX_TIER_B_FILES} for Tier B`,
    };
  }
  if (diff.linesChanged > MAX_TIER_B_LINES) {
    return {
      tier: 'C',
      reason: `${diff.linesChanged} lines exceeds max ${MAX_TIER_B_LINES} for Tier B`,
    };
  }

  return { tier: 'B', reason: `${diff.filesChanged.length} files, ${diff.linesChanged} lines, no banned paths` };
}
