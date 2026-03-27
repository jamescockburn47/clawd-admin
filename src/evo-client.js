// src/evo-client.js — Shared EVO X2 HTTP client infrastructure
// Single source for all EVO HTTP calls, health checks, and circuit breakers.
// Zero hardcoded IPs — all URLs from config.js.

import config from './config.js';
import logger from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TIMEOUTS } from './constants.js';

// --- Circuit breakers for EVO services ---

export const llamaBreaker = new CircuitBreaker('evo-llama', { threshold: 3, resetTimeout: 60000 });
export const memoryBreaker = new CircuitBreaker('evo-memory', { threshold: 3, resetTimeout: 60000 });
export const classifierBreaker = new CircuitBreaker('evo-classifier', { threshold: 3, resetTimeout: 30000 });
export const plannerBreaker = new CircuitBreaker('evo-planner', { threshold: 3, resetTimeout: 60000 });

// --- Shared fetch with timeout and abort ---

/**
 * Fetch from an EVO service with configurable timeout, AbortController, and structured error logging.
 *
 * @param {string} url - Full URL to fetch
 * @param {object} options - fetch options plus optional `timeout` (ms, default 10000)
 * @returns {Promise<Response>} - The raw fetch Response object
 * @throws {Error} on timeout, network error, or non-ok HTTP status
 */
export async function evoFetch(url, options = {}) {
  const timeout = options.timeout || TIMEOUTS.MEMORY_DEFAULT;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Strip custom options before passing to fetch
  const { timeout: _t, ...fetchOpts } = options;

  try {
    const resp = await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...fetchOpts.headers },
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => 'no body');
      const err = new Error(`EVO HTTP ${resp.status}: ${errBody.slice(0, 500)}`);
      err.status = resp.status;
      throw err;
    }

    return resp;
  } catch (err) {
    if (err.name === 'AbortError') {
      const abortErr = new Error(`EVO request timed out after ${timeout}ms: ${url}`);
      abortErr.name = 'AbortError';
      abortErr.code = 'TIMEOUT';
      logger.warn({ url, timeout }, 'evo request timed out');
      throw abortErr;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Convenience: evoFetch that returns parsed JSON.
 * Used by memory.js and other clients that always expect JSON responses.
 */
export async function evoFetchJSON(url, options = {}) {
  const resp = await evoFetch(url, options);
  return resp.json();
}

// --- Health checks ---

/**
 * Check if EVO X2's llama-server (port 8080) is healthy.
 * Returns true if healthy, false otherwise.
 */
export async function checkLlamaHealth() {
  try {
    const resp = await evoFetch(`${config.evoLlmUrl}/health`, {
      timeout: TIMEOUTS.EVO_HEALTH_CHECK,
    });
    const data = await resp.json();
    return data.status === 'ok' || data.status === 'no slot available';
  } catch {
    return false;
  }
}

/**
 * Check if EVO X2's memory service (port 5100) is healthy.
 * Returns the health data object on success, null on failure.
 */
export async function checkMemoryHealth() {
  try {
    const resp = await evoFetch(`${config.evoMemoryUrl}/health`, {
      timeout: TIMEOUTS.MEMORY_HEALTH_CHECK,
    });
    const data = await resp.json();
    if (data.status === 'online') {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if EVO X2's classifier (port 8081) is healthy.
 * Returns true if healthy, false otherwise.
 */
export async function checkClassifierHealth() {
  try {
    const resp = await evoFetch(`${config.evoClassifierUrl}/health`, {
      timeout: TIMEOUTS.EVO_HEALTH_CHECK,
    });
    const data = await resp.json();
    return data.status === 'ok' || data.status === 'no slot available';
  } catch {
    return false;
  }
}

/**
 * Check if EVO X2's 4B planner/classifier (port 8085) is healthy.
 * Returns true if healthy, false otherwise.
 */
export async function checkPlannerHealth() {
  try {
    const resp = await evoFetch(`${config.evoPlannerUrl}/health`, {
      timeout: TIMEOUTS.EVO_HEALTH_CHECK,
    });
    const data = await resp.json();
    return data.status === 'ok' || data.status === 'no slot available';
  } catch {
    return false;
  }
}
