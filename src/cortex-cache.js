// src/cortex-cache.js — Identity memory cache + per-stream timeout + deadline helpers
//
// Extracted from cortex.js to keep that file under the 300-line limit.
// Three primitives:
//   1. Identity cache — 5-min TTL on static identity memories
//   2. raceWithTimeout — per-stream timeout that returns a default on expiry
//   3. PHASE2_DEADLINE_MS — constant for the global phase 2 deadline
//
// All state is module-level. Cache invalidation is explicit via clearIdentityCache().
// Wired into memory.js store/update/delete to flush on any identity mutation.

import { getIdentityMemories } from './memory.js';
import logger from './logger.js';

// ── Identity memory cache ──
export const IDENTITY_CACHE_TTL = 300_000; // 5 minutes
const _identityCache = { results: [], ts: 0 };

/** Clear the identity cache. Called by memory.js on store/update/delete. */
export function clearIdentityCache() {
  _identityCache.results = [];
  _identityCache.ts = 0;
}

/** Test helper: force the cache to expire without waiting. */
export function _expireIdentityCacheForTest() {
  _identityCache.ts = 0;
}

/** Test helper: inspect cache state. */
export function _getIdentityCacheStateForTest() {
  return { size: _identityCache.results.length, ts: _identityCache.ts };
}

/**
 * Get identity memories, serving from cache when fresh.
 * On cache miss, fetches via memory service and populates the cache.
 * On fetch error, returns an empty array and logs — cache is not polluted.
 */
export async function getCachedIdentityMemories() {
  const now = Date.now();
  if (now - _identityCache.ts < IDENTITY_CACHE_TTL && _identityCache.results.length > 0) {
    return _identityCache.results;
  }
  try {
    const results = await getIdentityMemories();
    _identityCache.results = results;
    _identityCache.ts = now;
    return results;
  } catch (err) {
    logger.warn({ err: err.message }, 'cortex-cache: identity fetch failed');
    return [];
  }
}

// ── Per-stream timeout wrapper ──
export const STREAM_TIMEOUT_MS = 5_000;

/**
 * Race a promise against a timeout. Returns { value, timedOut } rather than
 * throwing so callers can distinguish "slow" from "failed".
 *
 * @param {Promise} promise - The stream to wrap
 * @param {number} timeoutMs - How long to wait before returning defaultValue
 * @param {*} defaultValue - Value to return on timeout
 * @returns {Promise<{value: *, timedOut: boolean}>}
 */
export function raceWithTimeout(promise, timeoutMs, defaultValue) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ value: defaultValue, timedOut: true }), timeoutMs);
  });
  const wrapped = promise.then(value => ({ value, timedOut: false }));
  return Promise.race([wrapped, timeout]).finally(() => clearTimeout(timer));
}

// ── Phase 2 global deadline ──
export const PHASE2_DEADLINE_MS = 8_000;

/**
 * Return the default value for a cortex stream by key.
 * Centralised so cortex.js and tests stay in sync.
 */
export function defaultForStream(key) {
  if (key === 'system') return '';
  if (key === 'webPrefetch') return null;
  return [];
}

/**
 * Execute a set of cortex phase 2 streams with per-stream timeout and global deadline.
 *
 * @param {object} streams - { [key]: Promise } map of named streams
 * @returns {Promise<{results: object, timings: object}>} results keyed by stream name,
 *   timings = { [key]: { ms, status: 'completed'|'timeout'|'error'|'deadline' } }
 */
export async function runPhase2Streams(streams) {
  const keys = Object.keys(streams);
  const timings = {};

  const wrapped = keys.map(key => {
    const def = defaultForStream(key);
    const t1 = Date.now();
    return raceWithTimeout(streams[key], STREAM_TIMEOUT_MS, def)
      .then(({ value, timedOut }) => {
        timings[key] = { ms: Date.now() - t1, status: timedOut ? 'timeout' : 'completed' };
        return value;
      })
      .catch(err => {
        timings[key] = { ms: Date.now() - t1, status: 'error' };
        logger.warn({ err: err.message, stream: key }, 'cortex-cache: stream error');
        return def;
      });
  });

  let deadlineFired = false;
  let deadlineTimer;
  const deadline = new Promise(resolve => {
    deadlineTimer = setTimeout(() => { deadlineFired = true; resolve(null); }, PHASE2_DEADLINE_MS);
  });
  const raceResult = await Promise.race([Promise.all(wrapped), deadline]);
  clearTimeout(deadlineTimer);

  let values;
  if (raceResult === null && deadlineFired) {
    const settled = await Promise.allSettled(wrapped);
    values = settled.map((s, i) => {
      const key = keys[i];
      if (s.status === 'fulfilled') return s.value;
      if (!timings[key]) timings[key] = { ms: PHASE2_DEADLINE_MS, status: 'deadline' };
      return defaultForStream(key);
    });
    const abandoned = keys.filter(k => timings[k]?.status !== 'completed');
    if (abandoned.length > 0) {
      logger.warn({ abandoned, deadlineMs: PHASE2_DEADLINE_MS }, 'cortex-cache: phase 2 deadline hit');
    }
  } else {
    values = raceResult;
  }

  const results = {};
  keys.forEach((k, i) => { results[k] = values[i]; });
  return { results, timings };
}
