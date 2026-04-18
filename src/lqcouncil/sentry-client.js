// src/lqcouncil/sentry-client.js — minimal Sentry REST API wrapper.
//
// Used by `lqc_recent_errors` and `lqc_why_failed` to correlate WA-side
// debate/bot context with the Sentry events those runs emitted. Kept
// independent of lqcouncil/client.js because it talks to a different
// upstream with different auth.

import config from '../config.js';
import logger from '../logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** True when all three Sentry env vars are set. */
export function isSentryConfigured() {
  return (
    !!config.lqcSentryApiToken
    && !!config.lqcSentryOrg
    && !!config.lqcSentryProjectBackend
  );
}

/**
 * Search Sentry issues in the backend project.
 *
 * @param {object} params
 * @param {string} [params.query]  — Sentry search query (e.g. "tag:debate_id:abc")
 * @param {number} [params.limit]  — max issues (Sentry caps at 100)
 * @param {string} [params.age]    — e.g. "-1h", "-24h". Default -24h.
 * @returns {Promise<Array<object>>} parsed issues
 */
export async function searchIssues({ query = '', limit = 10, age = '-24h' } = {}) {
  if (!isSentryConfigured()) {
    throw new Error('Sentry not configured — set LQC_SENTRY_API_TOKEN, LQC_SENTRY_ORG, LQC_SENTRY_PROJECT_BACKEND.');
  }

  const url = new URL(
    `https://sentry.io/api/0/projects/${encodeURIComponent(config.lqcSentryOrg)}/${encodeURIComponent(config.lqcSentryProjectBackend)}/issues/`,
  );
  const q = [`age:${age}`, query].filter(Boolean).join(' ');
  if (q) url.searchParams.set('query', q);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  url.searchParams.set('statsPeriod', age.replace(/^-/, ''));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      headers: {
        authorization: `Bearer ${config.lqcSentryApiToken}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Sentry issues query failed: HTTP ${resp.status} ${detail.slice(0, 200)}`);
    }
    const json = await resp.json();
    return Array.isArray(json) ? json : [];
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Sentry query timed out after ${DEFAULT_TIMEOUT_MS} ms`);
    }
    logger.warn({ err: err.message }, 'Sentry API call failed');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format Sentry issues into a short WA-friendly summary.
 * Returns a string — never throws.
 */
export function formatIssues(issues, { maxItems = 5 } = {}) {
  if (!issues || issues.length === 0) return '(no matching Sentry issues)';
  const lines = [];
  for (const issue of issues.slice(0, maxItems)) {
    const title = issue.title || issue.culprit || '(untitled)';
    const count = issue.count || 0;
    const lastSeen = issue.lastSeen ? new Date(issue.lastSeen).toISOString() : 'unknown';
    const tags = (issue.tags || [])
      .filter((t) => t.key === 'debate_id' || t.key === 'bot_id' || t.key === 'release')
      .map((t) => `${t.key}=${t.value}`)
      .join(' ');
    const url = issue.permalink || issue.shortId || '';
    lines.push(`  • [${count}×, last ${lastSeen}] ${title}${tags ? ` (${tags})` : ''}${url ? `\n    ${url}` : ''}`);
  }
  if (issues.length > maxItems) {
    lines.push(`  … plus ${issues.length - maxItems} more`);
  }
  return lines.join('\n');
}
