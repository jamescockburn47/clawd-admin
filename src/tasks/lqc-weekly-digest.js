// src/tasks/lqc-weekly-digest.js — Sunday 09:00 London digest post to
// LQC_DEV_GROUP_JID (or LQC_DIGEST_GROUP_JID if set) summarising the
// last 7 days of council activity.
//
// Sections: debate counts, top bots by success rate, Sentry-derived
// error summary when configured. Fallbacks when data is missing are
// explicit rather than silent.
//
// Time gating mirrors the existing daily-backup pattern: persist the
// last-run ISO date and skip if we've already posted today.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as lqc from '../lqcouncil/client.js';
import * as sentry from '../lqcouncil/sentry-client.js';
import logger from '../logger.js';

const STATE_DIR = join('data', 'runtime');
const STATE_PATH = join(STATE_DIR, 'lqc-digest-last-run.txt');
const DIGEST_HOUR = 9;
const DIGEST_MINUTE = 0;

let _sendProactive = null;
export function initWeeklyDigest(sendProactiveMessage) {
  _sendProactive = sendProactiveMessage;
}

function loadLast() {
  try { return existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8').trim() : null; }
  catch { return null; }
}

function saveLast(isoDate) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, isoDate, 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'weekly digest: state persist failed');
  }
}

function targetJid() {
  const override = (process.env.LQC_DIGEST_GROUP_JID || '').trim();
  if (override) return override;
  return (process.env.LQC_DEV_GROUP_JID || '').trim();
}

/**
 * Build the digest text from the LQC and Sentry APIs.
 * Returns null if the integration isn't enabled (caller logs).
 */
export async function buildWeeklyDigest() {
  if (!lqc.isEnabled()) return null;

  const lines = [`*LQ Council weekly digest*`, ''];

  try {
    const debates = await lqc.listDebates({ limit: 50 });
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const window = (debates || []).filter((d) => {
      const t = Date.parse(d.created_at);
      return Number.isFinite(t) && t >= cutoff;
    });
    const completed = window.filter((d) => d.status === 'complete');
    const failed = window.filter((d) => d.status === 'failed');
    const inFlight = window.filter((d) => !['complete', 'failed', 'cancelled'].includes(d.status));
    lines.push(`Past 7 days: ${window.length} debates — ${completed.length} complete, ${failed.length} failed, ${inFlight.length} still in flight.`);
  } catch (err) {
    lines.push(`Could not fetch debates: ${err.message}`);
  }

  try {
    const bots = await lqc.listBots();
    const active = (bots || []).filter((b) => b.status === 'active');
    if (active.length > 0) {
      const histories = await Promise.all(
        active.map(async (bot) => {
          const history = await lqc.getBotHistory(bot.id, { limit: 50 }).catch(() => []);
          const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const rows = history.filter((r) => {
            const t = Date.parse(r.created_at);
            return Number.isFinite(t) && t >= cutoff;
          });
          const failures = rows.filter((r) => r.abstained || !r.valid).length;
          return {
            bot,
            total: rows.length,
            failures,
            successRate: rows.length === 0 ? null : 1 - failures / rows.length,
          };
        }),
      );
      const rated = histories.filter((h) => h.total >= 3);
      if (rated.length > 0) {
        rated.sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0));
        lines.push('', '*Top bots by 7-day success rate (≥3 rounds):*');
        for (const h of rated.slice(0, 5)) {
          lines.push(`  • ${h.bot.name}: ${Math.round((h.successRate ?? 0) * 100)}% (${h.total - h.failures}/${h.total} rounds OK)`);
        }
      } else {
        lines.push('', '(No bots with ≥3 debate rounds this week.)');
      }
    }
  } catch (err) {
    lines.push(`Could not aggregate bots: ${err.message}`);
  }

  if (sentry.isSentryConfigured()) {
    try {
      const issues = await sentry.searchIssues({ age: '-7d', limit: 10 });
      lines.push('', '*Top Sentry issue groups (7d):*');
      lines.push(sentry.formatIssues(issues, { maxItems: 5 }));
    } catch (err) {
      lines.push('', `(Sentry issues query failed: ${err.message})`);
    }
  }

  return lines.join('\n');
}

/** Scheduler entry: fire on Sunday 09:00 London if not already fired today. */
export async function checkWeeklyDigest(todayStr, hours, minutes, dayOfWeek) {
  if (dayOfWeek !== 0) return;           // Sunday = 0
  if (hours !== DIGEST_HOUR || minutes !== DIGEST_MINUTE) return;
  if (loadLast() === todayStr) return;
  if (!_sendProactive) return;
  const jid = targetJid();
  if (!jid) {
    logger.info('weekly digest: no LQC_DEV_GROUP_JID — skipping');
    saveLast(todayStr);
    return;
  }
  try {
    const text = await buildWeeklyDigest();
    if (text) {
      await _sendProactive(jid, text);
      saveLast(todayStr);
      logger.info({ jid }, 'weekly digest sent');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'weekly digest failed');
  }
}

/** Manual trigger for scripts/run-task.js style testing. */
export async function runWeeklyDigestNow() {
  if (!_sendProactive) throw new Error('not initialised');
  const jid = targetJid();
  if (!jid) throw new Error('no target JID set');
  const text = await buildWeeklyDigest();
  if (!text) throw new Error('LQ integration disabled');
  await _sendProactive(jid, text);
  return { delivered: true, jid, preview: text.slice(0, 200) };
}
