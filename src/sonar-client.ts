// src/sonar-client.ts — Perplexity Sonar API client for grounded research
// Provides synthesised answers with citations via Sonar, and raw search via Search API.
// Falls back gracefully when API key is missing or service is down.

import config from './config.js';
import logger from './logger.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TIMEOUTS } from './constants.js';

const SONAR_BASE = 'https://api.perplexity.ai';
const SONAR_MODELS = Object.freeze({
  FAST: 'sonar',
  DEEP: 'sonar-pro',
  REASONING: 'sonar-reasoning-pro',
});

interface SonarOptions {
  model?: string;
  maxTokens?: number;
  timeout?: number;
  searchMode?: 'web' | 'academic' | 'sec';
}

interface SonarResult {
  content: string;
  citations: string[];
  model: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const breaker = new CircuitBreaker('sonar', { threshold: 3, resetTimeout: 60_000 });

/** Check if Sonar is configured and available. */
export function isSonarAvailable(): boolean {
  return !!(config.perplexityEnabled && config.perplexityApiKey);
}

/**
 * Call Perplexity Sonar API for synthesised, cited research.
 * Returns null if unconfigured or on failure (caller should fall back to SearXNG).
 */
export async function sonarResearch(
  query: string,
  opts: SonarOptions = {},
): Promise<SonarResult | null> {
  if (!isSonarAvailable()) return null;

  const model = opts.model ?? SONAR_MODELS.FAST;
  const timeout = opts.timeout ?? TIMEOUTS.SONAR_SEARCH;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const result = await breaker.call(async () => {
      const resp = await fetch(`${SONAR_BASE}/v1/sonar`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.perplexityApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: query }],
          max_tokens: opts.maxTokens ?? 2000,
          search_mode: opts.searchMode ?? 'web',
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => 'no body');
        throw new Error(`Sonar HTTP ${resp.status}: ${body.slice(0, 300)}`);
      }

      return resp.json();
    }, null);

    if (!result) return null;

    const choice = result.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      citations: result.citations ?? [],
      model: result.model ?? model,
    };
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'sonar request timed out' : err.message;
    logger.warn({ query: query.slice(0, 100), err: msg }, 'sonar research failed');
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Convenience: fast research via sonar model. */
export async function sonarFast(query: string): Promise<SonarResult | null> {
  return sonarResearch(query, { model: SONAR_MODELS.FAST, timeout: TIMEOUTS.SONAR_SEARCH });
}

/** Convenience: deep research via sonar-pro model. */
export async function sonarDeep(query: string): Promise<SonarResult | null> {
  return sonarResearch(query, { model: SONAR_MODELS.DEEP, timeout: TIMEOUTS.SONAR_DEEP });
}

/**
 * Raw search via Perplexity Search API. Returns ranked results without synthesis.
 * Useful as a middle ground between SearXNG and full Sonar synthesis.
 */
export async function sonarSearch(
  query: string,
  maxResults = 5,
): Promise<SearchResult[] | null> {
  if (!isSonarAvailable()) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.SONAR_SEARCH);

  try {
    const resp = await fetch(`${SONAR_BASE}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({ query, max_results: maxResults }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => 'no body');
      throw new Error(`Sonar Search HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }

    const data = await resp.json();
    return (data.results ?? []).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.snippet ?? '',
    }));
  } catch (err: any) {
    logger.warn({ query: query.slice(0, 100), err: err.message }, 'sonar search failed');
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export { SONAR_MODELS };
