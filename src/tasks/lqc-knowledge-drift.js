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
    recommended_action:
      'Review data/lqcouncil-knowledge.json — specifically the chunks whose content depends on the drifted field (roles → `roles` chunk; errorKinds → `error-taxonomy` chunk; roundCount → `rounds` chunk; roundTimeoutSeconds → `endpoint-contract` chunk). Update prose, bump version, commit.',
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
  const newSnap = extractFactsFromCheckout(botCouncilDir);
  const changes = diffSnapshots(oldSnap, newSnap);

  let proposalPath = null;
  // Only write proposals for non-trivial drift (skip initial-snapshot bootstrap).
  const actionable = changes.filter((c) => c.kind !== 'initial-snapshot');
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
