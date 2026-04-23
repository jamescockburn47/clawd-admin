// src/tasks/lqc-knowledge-drift.js — detect when bot-council source
// diverges from the facts baked into data/lqcouncil-knowledge.json.
//
// Runs nightly at 02:10 London, shortly after project-sync at 02:00
// (which pulls bot-council sources into memory + keeps the on-disk
// checkout fresh). Also callable on-demand via POST /api/lqcouncil-
// knowledge-refresh so a GitHub Action in bot-council can trigger a
// re-check immediately on push to main.
//
// Strategy: snapshot-then-diff. Parse authoritative structural facts
// from bot-council Rust source (roles, error_kind taxonomy, round
// count, timeout config). Compare against the previous snapshot.
// Write a proposal + event when drift detected; do NOT auto-patch
// narrative content — that requires human curation. Persist the new
// snapshot as the baseline for the next run.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFactsFromCheckout, diffSnapshots } from '../lqcouncil/facts-extractor.js';
import { appendEvent } from '../overnight/events.js';
import logger from '../logger.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_BOT_COUNCIL_DIR = process.env.BOT_COUNCIL_DIR || '/home/james/bot-council';
const DEFAULT_SNAPSHOT_FILE = join(REPO_ROOT, 'data', 'lqcouncil-facts-snapshot.json');
const DEFAULT_PROPOSALS_DIR = join(REPO_ROOT, 'data', 'overnight', 'proposals');

export const DRIFT_HOUR = 2;
export const DRIFT_MINUTE = 10;

let lastDriftDate = null;

export function resetDriftStateForTests() {
  lastDriftDate = null;
}

function loadSnapshot(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message, file }, 'lqc-knowledge-drift: snapshot load failed');
    return null;
  }
}

function writeSnapshot(file, snap) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(snap, null, 2) + '\n', 'utf8');
}

// Chunk mapping: which knowledge chunks reference which facts. Used in
// the proposal's recommended_action so the reviewer doesn't have to
// guess which section of data/lqcouncil-knowledge.json is affected.
const FIELD_TO_CHUNKS = {
  roles: ['roles'],
  errorKinds: ['error-taxonomy'],
  roundCount: ['rounds'],
  roundTimeoutSeconds: ['endpoint-contract', 'rounds'],
  apiRoutes: ['onboarding', 'admin-operations', 'operational-facts', 'test-before-submit'],
  frontendRoutes: ['onboarding', 'test-before-submit'],
  'claudeMd.sections': ['overview', 'architecture-topology'],
  'claudeMd.urls': ['onboarding', 'architecture-topology', 'operational-facts'],
  'claudeMd.hash': [],   // low-priority, typo-level
};

function chunksForChange(c) {
  const key = c.field || c.kind;
  return FIELD_TO_CHUNKS[key] || [];
}

function buildRecommendedAction(changes) {
  const affectedChunks = new Set();
  for (const c of changes) {
    for (const ch of chunksForChange(c)) affectedChunks.add(ch);
  }
  if (affectedChunks.size === 0) {
    return 'Low-signal drift detected (content-level hash change only). No action required unless sections/urls also changed.';
  }
  const list = [...affectedChunks].sort().map((c) => `\`${c}\``).join(', ');
  return `Review data/lqcouncil-knowledge.json chunks: ${list}. Update prose, bump version (2.1.x), commit.`;
}

function writeProposal(changes, snap, proposalsDir) {
  mkdirSync(proposalsDir, { recursive: true });
  const filename = `lqc-knowledge-drift-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const path = join(proposalsDir, filename);
  const payload = {
    type: 'lqc-knowledge-drift',
    detected_at: new Date().toISOString(),
    source_repo: snap.repoRoot,
    changes,
    current_snapshot: snap,
    recommended_action: buildRecommendedAction(changes),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return path;
}

function summariseChanges(changes) {
  if (changes.length === 0) return 'no drift';
  return changes
    .map((c) => {
      if (c.kind === 'initial-snapshot') return 'initial snapshot';
      if (c.kind === 'source-unavailable') return 'source unavailable';
      if (c.kind === 'array-diff') {
        const parts = [];
        if (c.added.length > 0) parts.push(`${c.field}+${c.added.join(',')}`);
        if (c.removed.length > 0) parts.push(`${c.field}-${c.removed.join(',')}`);
        return parts.join(' ');
      }
      if (c.kind === 'scalar-diff') {
        return `${c.field}: ${c.old}→${c.new}`;
      }
      if (c.kind === 'api-routes-diff') {
        const parts = [];
        if (c.added?.length) parts.push(`apiRoutes+${c.added.length}`);
        if (c.removed?.length) parts.push(`apiRoutes-${c.removed.length}`);
        if (c.changed?.length) parts.push(`apiRoutes~${c.changed.length}`);
        return parts.join(' ');
      }
      if (c.kind === 'claude-md-hash-only') {
        return `claudeMd hash ${c.old}→${c.new} (content-only)`;
      }
      if (c.kind === 'frontend-routes-first-snapshot') {
        return `frontendRoutes first snapshot (${c.count} paths, ${c.source})`;
      }
      if (c.kind === 'frontend-source-unavailable') {
        return 'frontend source unavailable (transient?)';
      }
      return c.kind;
    })
    .join('; ');
}

/**
 * @typedef {Object} DriftRunOptions
 * @property {string} [botCouncilDir]
 * @property {string} [snapshotFile]
 * @property {string} [proposalsDir]
 * @property {string} [reason]
 * @property {object} [extractOptions] — passed through to
 *   extractFactsFromCheckout (githubOwner/Repo/Branch, fetchFn for tests).
 */

/**
 * Execute one drift-detection run. Exported for tests + the on-demand
 * HTTP endpoint. Returns a structured result for the caller.
 *
 * @param {DriftRunOptions} [opts]
 */
export async function runKnowledgeDriftCheck(opts = {}) {
  const botCouncilDir = opts.botCouncilDir ?? DEFAULT_BOT_COUNCIL_DIR;
  const snapshotFile = opts.snapshotFile ?? DEFAULT_SNAPSHOT_FILE;
  const proposalsDir = opts.proposalsDir ?? DEFAULT_PROPOSALS_DIR;
  const reason = opts.reason ?? 'scheduled';

  const oldSnap = loadSnapshot(snapshotFile);
  const newSnap = await extractFactsFromCheckout(botCouncilDir, opts.extractOptions || {});
  const changes = diffSnapshots(oldSnap, newSnap);

  let proposalPath = null;
  // Only write proposals for non-trivial drift. These kinds are either
  // bootstrap/transient (first-snapshot, source-unavailable) or
  // intentionally low-signal (hash-only with no section/url change).
  const NON_ACTIONABLE_KINDS = new Set([
    'initial-snapshot',
    'frontend-routes-first-snapshot',
    'frontend-source-unavailable',
    'claude-md-hash-only',
  ]);
  const actionable = changes.filter((c) => !NON_ACTIONABLE_KINDS.has(c.kind));
  if (actionable.length > 0) {
    proposalPath = writeProposal(changes, newSnap, proposalsDir);
  }

  // Always persist the new snapshot as the next-run baseline.
  writeSnapshot(snapshotFile, newSnap);

  try {
    await appendEvent({
      stage: 'operations',
      phase: 'lqc-knowledge-drift',
      inputs: [botCouncilDir],
      outputs: proposalPath ? [proposalPath] : [],
      verdict: actionable.length > 0 ? 'rejected' : 'ok',
      reason: `${reason}: ${summariseChanges(changes)}`,
      evidence_refs: actionable.map((c) => c.kind + (c.field ? `:${c.field}` : '')),
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'lqc-knowledge-drift: event append failed');
  }

  return {
    reason,
    changes,
    actionable,
    proposalPath,
    sourceAvailable: newSnap.sourceAvailable,
  };
}

/**
 * Scheduler entry. Runs once per day at 02:10 London.
 */
export async function checkKnowledgeDrift(todayStr, hours, minutes) {
  if (hours !== DRIFT_HOUR || minutes !== DRIFT_MINUTE) return;
  if (lastDriftDate === todayStr) return;
  lastDriftDate = todayStr;
  try {
    await runKnowledgeDriftCheck({ reason: 'scheduled' });
  } catch (err) {
    logger.error({ err: err.message }, 'lqc-knowledge-drift: scheduled run failed');
  }
}
