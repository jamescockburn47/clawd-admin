// src/tasks/lqc-bot-failure-nudge.js — daily 10:00 London nudge when an
// active bot's last-20-round failure rate exceeds the threshold (default
// 0.7). The plan called for a DM to the bot's submitter, but mapping a
// Clerk user_id to a WA JID is out of scope overnight, so we post to
// LQC_DEV_GROUP_JID with a pointer to the specific bot + its
// lqc_bot_diagnose command. James can then loop the author in manually.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as lqc from '../lqcouncil/client.js';
import logger from '../logger.js';

const STATE_DIR = join('data', 'runtime');
const STATE_PATH = join(STATE_DIR, 'lqc-failure-nudge-last-run.txt');
const NUDGE_HOUR = 10;
const NUDGE_MINUTE = 0;

let _sendProactive = null;
export function initFailureNudge(sendProactiveMessage) {
  _sendProactive = sendProactiveMessage;
}

function threshold() {
  const raw = parseFloat(process.env.LQC_NUDGE_FAILURE_THRESHOLD || '0.7');
  return Number.isFinite(raw) ? raw : 0.7;
}

function loadLast() {
  try { return existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8').trim() : null; }
  catch { return null; }
}
function saveLast(iso) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, iso, 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'nudge: state persist failed');
  }
}

export async function buildFailureNudges() {
  if (!lqc.isEnabled()) return [];
  const bots = await lqc.listBots();
  const active = (bots || []).filter((b) => b.status === 'active');
  if (active.length === 0) return [];
  const out = [];
  for (const bot of active) {
    // /api/bots/{id}/history returns per-DEBATE aggregates, not per-round.
    // Each record carries {rounds_total, abstained_rounds, invalid_rounds,
    // ...}. Sum across debates to get round-level abstention rate.
    const history = await lqc.getBotHistory(bot.id, { limit: 20 }).catch(() => []);
    if (history.length === 0) continue;
    let totalRounds = 0;
    let badRounds = 0;
    for (const d of history) {
      totalRounds += d.rounds_total || 0;
      badRounds += (d.abstained_rounds || 0) + (d.invalid_rounds || 0);
    }
    if (totalRounds < 5) continue; // need enough signal
    const rate = badRounds / totalRounds;
    if (rate < threshold()) continue;
    out.push({
      bot,
      debates: history.length,
      totalRounds,
      badRounds,
      rate,
      submittedBy: bot.submitted_by || null,
    });
  }
  return out;
}

export async function checkFailureNudge(todayStr, hours, minutes) {
  if (hours !== NUDGE_HOUR || minutes !== NUDGE_MINUTE) return;
  if (loadLast() === todayStr) return;
  if (!_sendProactive) return;
  const jid = (process.env.LQC_DEV_GROUP_JID || '').trim();
  if (!jid) {
    saveLast(todayStr);
    return;
  }
  try {
    const nudges = await buildFailureNudges();
    if (nudges.length === 0) {
      saveLast(todayStr);
      return;
    }
    const lines = [`*LQ Council: bots needing attention*`, ''];
    for (const n of nudges.slice(0, 10)) {
      const author = n.submittedBy ? ` (submitted by ${n.submittedBy})` : '';
      lines.push(`  • ${n.bot.name}${author}: ${Math.round(n.rate * 100)}% abstention/invalid rate (${n.badRounds}/${n.totalRounds} rounds across ${n.debates} debates)`);
      lines.push(`    Run: lqc_bot_diagnose ${n.bot.id}`);
    }
    if (nudges.length > 10) lines.push(`  … plus ${nudges.length - 10} more`);
    await _sendProactive(jid, lines.join('\n'));
    saveLast(todayStr);
    logger.info({ count: nudges.length }, 'failure nudge sent');
  } catch (err) {
    logger.error({ err: err.message }, 'failure nudge failed');
  }
}
