// Task: Morning briefing dispatch

import { getWidgetData } from '../widgets.js';
import { getActiveTodos } from '../tools/todo.js';
import { getEvoStatus, getMemoryStats } from '../memory.js';
import config from '../config.js';
import logger from '../logger.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, join as pathJoin } from 'path';
import { homedir } from 'os';

const STATE_FILE = join('data', 'briefing-state.json');

function loadState() {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to save briefing state');
  }
}

const persisted = loadState();
function yesterdayOf(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

let lastBriefingDate = persisted.lastBriefingDate || null;

/**
 * Send morning briefing at the configured time (London timezone).
 * @param {Function} sendFn - WhatsApp send function
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 * @param {number} minutes - Current London minute
 */
export async function checkMorningBriefing(sendFn, todayStr, hours, minutes) {
  if (!config.briefingEnabled || !sendFn) return;

  if (lastBriefingDate === todayStr) return;

  const [targetH, targetM] = config.briefingTime.split(':').map(Number);
  if (hours < targetH || (hours === targetH && minutes < targetM)) return;
  // Don't send if we're more than 2 hours past the target time (prevents catch-up on evening restarts)
  const minutesSinceTarget = (hours - targetH) * 60 + (minutes - targetM);
  if (minutesSinceTarget > 120) return;

  lastBriefingDate = todayStr;
  saveState({ lastBriefingDate, lastReviewDate });

  try {
    const widgets = await getWidgetData();
    // Note: todos intentionally NOT included; James sees todos all day in
    // the dashboard. The morning DM is for things that are NEW.

    const sections = [];
    const dayName = new Date(todayStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    sections.push(`*Good morning.* ${dayName}.`);

    // Weather, calendar, side-gig, Henry — these vary day-to-day and are
    // genuinely useful for the morning. Keep concise.
    if (widgets?.weather?.length > 0) {
      const weatherLines = widgets.weather.map(w => `${w.location}: ${w.temp}C, ${w.description}`);
      sections.push(`*Weather*\n${weatherLines.join('\n')}`);
    }

    if (widgets?.calendar?.length > 0) {
      const todayEvents = widgets.calendar.filter(e => (e.start || '').split('T')[0] === todayStr);
      if (todayEvents.length > 0) {
        const lines = todayEvents.map(e => {
          const time = e.start?.includes('T')
            ? new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
            : 'All day';
          return `  ${time} -- ${e.summary}`;
        });
        sections.push(`*Calendar* (${todayEvents.length})\n${lines.join('\n')}`);
      }
    }

    if (widgets?.sideGig?.length > 0) {
      const todayMeetings = widgets.sideGig.filter(m => (m.start || '').split('T')[0] === todayStr);
      if (todayMeetings.length > 0) {
        const lines = todayMeetings.map(m => {
          const tags = (m.tags || []).join('/');
          const time = new Date(m.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
          return `  ${time} -- ${tags ? '[' + tags + '] ' : ''}${m.summary}`;
        });
        sections.push(`*Side gig*\n${lines.join('\n')}`);
      }
    }

    if (widgets?.henryWeekends?.length > 0) {
      const next = widgets.henryWeekends[0];
      const daysUntil = Math.ceil((new Date(next.startDate) - new Date(todayStr)) / 86400000);
      // Only show if upcoming OR something unbooked.
      const flags = [];
      if (!next.travelBooked && next.needsTravel) flags.push('travel NOT booked');
      if (!next.accommodationBooked && next.needsAccommodation) flags.push('accom NOT booked');
      if (daysUntil <= 14 || flags.length > 0) {
        sections.push(`*Henry:* ${next.startDate} (${daysUntil}d)${flags.length ? ' -- ' + flags.join(', ') : ''}`);
      }
    }

    // === The actual NOVEL content: last night's dream + diary ===
    // ~/clawdbot-logs/overnight-report-<date>.json is written by
    // dream_mode.py at 22:05 and carries the only output that actually
    // varies day-to-day in a useful way: the diary entry, newly extracted
    // facts, and evidence-cited insights.
    try {
      const dreamPath = pathJoin(homedir(), 'clawdbot-logs', `overnight-report-${todayStr}.json`);
      const yesterdayPath = pathJoin(homedir(), 'clawdbot-logs', `overnight-report-${yesterdayOf(todayStr)}.json`);
      let dream = null;
      let dreamDate = null;
      if (existsSync(dreamPath)) {
        dream = JSON.parse(readFileSync(dreamPath, 'utf-8'));
        dreamDate = todayStr;
      } else if (existsSync(yesterdayPath)) {
        // Edge case: dream fires at 22:05 of date N-1; if briefing runs
        // before today's dream has fired, fall back to last night's.
        dream = JSON.parse(readFileSync(yesterdayPath, 'utf-8'));
        dreamDate = yesterdayOf(todayStr);
      }
      if (dream && Array.isArray(dream.groups) && dream.groups.length > 0) {
        const dreamLines = [];
        const totals = dream.totals || {};
        if (dreamDate && dreamDate !== todayStr) {
          dreamLines.push(`*Last night's dream* (from ${dreamDate})`);
        } else {
          dreamLines.push(`*Last night's dream*`);
        }
        // Diary text — most useful single output. Take first group's diary;
        // multi-group dreams are rare and the first is usually the main chat.
        const primary = dream.groups[0];
        if (primary?.diary) {
          dreamLines.push(primary.diary.trim());
        }
        // New facts (top 5) — concise, surprise-worthy
        const facts = (primary?.facts || []).slice(0, 5);
        if (facts.length > 0) {
          dreamLines.push('');
          dreamLines.push('*New facts*');
          for (const f of facts) {
            dreamLines.push(`  - ${f.fact}`);
          }
        }
        // Evidence-grounded insights
        const insights = primary?.insights || [];
        if (insights.length > 0) {
          dreamLines.push('');
          dreamLines.push('*Insights*');
          for (const i of insights) {
            dreamLines.push(`  - ${i.insight}`);
          }
        }
        sections.push(dreamLines.join('\n'));
      } else {
        sections.push('*Dream:* nothing extractable from yesterday\'s logs.');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'briefing dream load failed');
    }

    // === Critical errors only ===
    // Pull from the structured event log; only mention failed verdicts.
    // No counts, no boilerplate, no "0 backed up" filler.
    try {
      const { join: pj, dirname: dn, resolve: rs } = await import('node:path');
      const { fileURLToPath: ftu } = await import('node:url');
      const moduleDir = dn(ftu(import.meta.url));
      const repoRoot = rs(moduleDir, '..', '..');
      const eventsFile = pj(repoRoot, 'data', 'overnight', `events-${todayStr}.jsonl`);
      if (existsSync(eventsFile)) {
        const errors = [];
        for (const line of readFileSync(eventsFile, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            if (e.verdict === 'failed') {
              errors.push(`  ${e.stage}/${e.phase}: ${(e.reason || '').slice(0, 100)}`);
            }
          } catch { /* ignore malformed line */ }
        }
        if (errors.length > 0) {
          sections.push(`*Errors overnight* (${errors.length})\n${errors.slice(0, 5).join('\n')}`);
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'briefing error scan failed');
    }

    const briefing = sections.join('\n\n');
    await sendFn(briefing);
    logger.info('morning briefing sent');
  } catch (err) {
    logger.error({ err: err.message }, 'morning briefing failed');
  }
}

// Weekly memory review (Sunday 8pm)
let lastReviewDate = persisted.lastReviewDate || null;

/**
 * Send weekly memory review on Sundays at 8pm.
 * @param {Function} sendFn - WhatsApp send function
 * @param {string} todayStr - YYYY-MM-DD date string
 * @param {number} hours - Current London hour
 */
export async function checkWeeklyReview(sendFn, todayStr, hours) {
  if (!config.evoMemoryEnabled || !sendFn) return;

  const dayOfWeek = new Date(todayStr + 'T12:00:00').getDay(); // 0 = Sunday

  if (dayOfWeek !== 0) return;
  if (lastReviewDate === todayStr) return;
  if (hours < 20 || hours > 21) return;

  lastReviewDate = todayStr;
  saveState({ lastBriefingDate, lastReviewDate });

  try {
    const stats = await getMemoryStats();
    if (!stats || !stats.total) return;

    const cats = stats.categories || {};
    const catLines = Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `  ${cat}: ${count}`)
      .join('\n');

    const msg = `*Weekly Memory Review*\n\nTotal memories: ${stats.total}\n\n${catLines}\n\nReply to correct any memories, or say "show memories about [topic]" to review specific areas.`;
    await sendFn(msg);
    logger.info('weekly memory review sent');
  } catch (err) {
    logger.error({ err: err.message }, 'weekly review failed');
  }
}

export function getLastBriefingDate() { return lastBriefingDate; }
export function getLastReviewDate() { return lastReviewDate; }
