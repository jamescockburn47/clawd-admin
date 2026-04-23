// src/tasks/lqc-repo-poll.js — every-15-minute pull-based check of
// bot-council's main-branch HEAD. When HEAD changes, triggers a
// knowledge-drift run against the fresh commit.
//
// Pull-based by design: belt-and-braces with the push-based
// /api/lqcouncil-knowledge-refresh webhook. Even if the push path is
// never wired (no GitHub Action, no ship.sh hook), the pull path keeps
// Clint current to within 15 minutes — well under the previous 24 h
// cron lag.
//
// Pure GitHub REST (no `git` binary dependency), no auth required for a
// public repo. Cheap: one request every quarter hour, ~2 KB payload.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runKnowledgeDriftCheck } from './lqc-knowledge-drift.js';
import logger from '../logger.js';

const STATE_DIR = join('data', 'runtime');
const STATE_PATH = join(STATE_DIR, 'lqc-repo-poll-state.json');
const DEFAULT_OWNER = process.env.LQC_REPO_OWNER || 'jamescockburn47';
const DEFAULT_REPO = process.env.LQC_REPO_NAME || 'bot-council';
const DEFAULT_BRANCH = process.env.LQC_REPO_BRANCH || 'main';

const POLL_INTERVAL_MINUTES = 15;

// ── State ───────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return { sha: null, lastChecked: null, lastChanged: null };
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sha: null, lastChecked: null, lastChanged: null };
  }
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'lqc-repo-poll: state persist failed');
  }
}

// ── Remote HEAD fetch ───────────────────────────────────────────────

/**
 * Fetch the current HEAD commit SHA for a GitHub branch. Returns null
 * on any failure (network, rate-limit, 404). No auth needed for public
 * repos.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.branch
 * @param {typeof fetch} [opts.fetchFn] — injected for tests
 */
export async function fetchRemoteHead({ owner, repo, branch, fetchFn = globalThis.fetch } = {}) {
  if (!owner || !repo || !branch) return null;
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
  try {
    const res = await fetchFn(url, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'clawdbot-repo-poll' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.sha !== 'string') return null;
    return { sha: data.sha, date: data.commit?.author?.date || null, message: data.commit?.message || null };
  } catch {
    return null;
  }
}

// ── Poll logic ──────────────────────────────────────────────────────

/**
 * One poll tick. Fetches upstream HEAD, compares to state, runs drift
 * check on change. Pure function over injected deps for testability.
 *
 * @param {object} deps
 * @param {typeof fetch} [deps.fetchFn]
 * @param {function} [deps.runDrift] — override for tests
 * @param {string} [deps.statePath] — override for tests
 * @param {object} [deps.repo] — {owner,repo,branch} override for tests
 * @param {object} [deps.driftExtractOptions] — passed to runKnowledgeDriftCheck
 */
export async function pollRepoHead(deps = {}) {
  const statePath = deps.statePath || STATE_PATH;
  const repo = deps.repo || { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: DEFAULT_BRANCH };
  const runDrift = deps.runDrift || runKnowledgeDriftCheck;
  const fetchFn = deps.fetchFn;

  const state = (() => {
    try {
      if (!existsSync(statePath)) return { sha: null, lastChecked: null, lastChanged: null };
      return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      return { sha: null, lastChecked: null, lastChanged: null };
    }
  })();

  const head = await fetchRemoteHead({ ...repo, fetchFn });
  const now = new Date().toISOString();
  if (!head) {
    // Transient upstream failure — record and skip.
    state.lastChecked = now;
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch { /* intentional: state write is best-effort */ }
    return { ok: false, reason: 'upstream-unreachable', sha: state.sha };
  }

  if (state.sha === head.sha) {
    // No-op tick. Don't run drift. Persist lastChecked only.
    state.lastChecked = now;
    try {
      mkdirSync(join(statePath, '..'), { recursive: true });
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch { /* intentional: state write is best-effort */ }
    return { ok: true, reason: 'no-change', sha: head.sha };
  }

  // SHA moved — fire a drift check with "push-like" reason and the
  // commit SHA tagged in.
  logger.info({ oldSha: state.sha, newSha: head.sha }, 'lqc-repo-poll: upstream moved');
  let driftResult = null;
  try {
    driftResult = await runDrift({
      reason: `repo-poll:${head.sha.slice(0, 7)}`,
      extractOptions: deps.driftExtractOptions,
    });
  } catch (err) {
    logger.error({ err: err.message, sha: head.sha }, 'lqc-repo-poll: drift check failed');
  }

  state.sha = head.sha;
  state.lastChecked = now;
  state.lastChanged = now;
  state.lastCommit = { sha: head.sha, date: head.date, message: head.message };
  try {
    mkdirSync(join(statePath, '..'), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'lqc-repo-poll: state persist failed');
  }
  return {
    ok: true,
    reason: 'changed',
    oldSha: state.sha === head.sha ? null : state.sha,
    sha: head.sha,
    drift: driftResult ? {
      actionable: driftResult.actionable?.length || 0,
      proposal: driftResult.proposalPath || null,
    } : null,
  };
}

// ── Scheduler entry ─────────────────────────────────────────────────

let lastTickMinute = null;

/**
 * Runs on the scheduler's 60 s cadence. Fires pollRepoHead when the
 * current minute is a multiple of POLL_INTERVAL_MINUTES and we haven't
 * already fired this minute. Missing-minute-drift safe because the
 * scheduler sweeps the current minute on each tick.
 */
export async function checkRepoPoll(todayStr, hours, minutes) {
  if (minutes % POLL_INTERVAL_MINUTES !== 0) return;
  const tickKey = `${todayStr}:${hours}:${minutes}`;
  if (lastTickMinute === tickKey) return;
  lastTickMinute = tickKey;
  try {
    await pollRepoHead();
  } catch (err) {
    logger.error({ err: err.message }, 'lqc-repo-poll: tick failed');
  }
}

export function resetRepoPollStateForTests() {
  lastTickMinute = null;
}

export function getLastPollState() {
  return loadState();
}
