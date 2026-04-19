// src/lqcouncil/facts-extractor.js — pull authoritative structural facts
// from the bot-council repo source, for drift detection.
//
// Pure functions. No I/O beyond file reads passed in by caller. Works
// against a checkout of jamescockburn47/bot-council (on EVO:
// /home/james/bot-council — synced nightly by project-sync).
//
// The goal is NOT to validate the curated knowledge is correct — it is
// to detect when the underlying source-of-truth changed so a human can
// review whether lqcouncil-knowledge.json needs re-curating. Cheap,
// deterministic, debuggable.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Parse the Role enum from src/types.rs. Returns snake_case names ordered
 * as they appear in the source (significant — that's the default rotation
 * pool order).
 */
export function parseRolesFromTypes(content) {
  const m = content.match(/pub\s+enum\s+Role\s*\{([\s\S]*?)\}/);
  if (!m) return [];
  const body = m[1];
  const variants = body
    .split(/[,\n]/)
    .map((s) => s.replace(/\/\/.*$/, '').trim())
    .filter((s) => s.length > 0 && /^[A-Z][A-Za-z0-9]*$/.test(s));
  return variants.map((v) => v.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
}

/**
 * Parse error-kind string literals from src/orchestrator/error_kind.rs.
 * Returns sorted unique list.
 */
export function parseErrorKinds(content) {
  const matches = [...content.matchAll(/kind:\s*"([a-z0-9_]+)"/g)];
  return [...new Set(matches.map((m) => m[1]))].sort();
}

/**
 * Parse round count from src/orchestrator/state_machine.rs. Returns
 * integer (for `0..=4` returns 5).
 */
export function parseRoundCount(content) {
  const m = content.match(/for\s+round\s+in\s+0\.\.=\s*(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) + 1;
}

/**
 * Parse per-round timeout seconds. Looks for config `default_timeout_secs`
 * or similar constants.
 */
export function parseRoundTimeoutSeconds(content) {
  // Search for decl like `default_timeout_secs: u64 = 300` or
  // `const DEFAULT_TIMEOUT_SECS: u64 = 300` or config.toml entry.
  const patterns = [
    /default_timeout_secs\s*[:=]\s*(?:u64\s*=\s*)?(\d+)/,
    /DEFAULT_TIMEOUT_SECS\s*:\s*u64\s*=\s*(\d+)/,
    /timeout_secs\s*=\s*(\d+)/,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Extract the snapshot from a checkout directory. Missing files are
 * tolerated — the field is set to null so the snapshot is comparable.
 */
export function extractFactsFromCheckout(repoRoot) {
  if (!existsSync(repoRoot)) {
    return { sourceAvailable: false, repoRoot };
  }
  const safeRead = (relPath) => {
    const full = join(repoRoot, relPath);
    if (!existsSync(full)) return null;
    try {
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };

  const typesContent = safeRead('src/types.rs');
  const errorKindContent = safeRead('src/orchestrator/error_kind.rs');
  const stateMachineContent = safeRead('src/orchestrator/state_machine.rs');
  const configContent = safeRead('config/default.toml');

  return {
    sourceAvailable: true,
    repoRoot,
    roles: typesContent ? parseRolesFromTypes(typesContent) : [],
    errorKinds: errorKindContent ? parseErrorKinds(errorKindContent) : [],
    roundCount: stateMachineContent ? parseRoundCount(stateMachineContent) : null,
    roundTimeoutSeconds:
      (configContent && parseRoundTimeoutSeconds(configContent)) ||
      (errorKindContent && parseRoundTimeoutSeconds(errorKindContent)) ||
      null,
  };
}

/**
 * Diff two snapshots. Returns an array of change records. Empty array means
 * identical.
 */
export function diffSnapshots(oldSnap, newSnap) {
  const changes = [];
  if (!oldSnap || !oldSnap.sourceAvailable) {
    // First run — treat as initial snapshot, not drift.
    return [{ kind: 'initial-snapshot', newSnap }];
  }
  if (!newSnap || !newSnap.sourceAvailable) {
    changes.push({
      kind: 'source-unavailable',
      oldPath: oldSnap.repoRoot,
      newPath: newSnap?.repoRoot,
    });
    return changes;
  }

  const arrDiff = (field, a, b) => {
    const sa = [...(a || [])].sort();
    const sb = [...(b || [])].sort();
    if (JSON.stringify(sa) === JSON.stringify(sb)) return null;
    const added = sb.filter((x) => !sa.includes(x));
    const removed = sa.filter((x) => !sb.includes(x));
    return { field, added, removed, old: sa, new: sb };
  };

  for (const field of ['roles', 'errorKinds']) {
    const d = arrDiff(field, oldSnap[field], newSnap[field]);
    if (d) changes.push({ kind: 'array-diff', ...d });
  }
  for (const field of ['roundCount', 'roundTimeoutSeconds']) {
    if (oldSnap[field] !== newSnap[field]) {
      changes.push({
        kind: 'scalar-diff',
        field,
        old: oldSnap[field],
        new: newSnap[field],
      });
    }
  }
  return changes;
}
