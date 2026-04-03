// Task: Morning briefing dispatch

import { getWidgetData } from '../widgets.js';
import { getActiveTodos } from '../tools/todo.js';
import { getEvoStatus, getMemoryStats, isEvoOnline, getOvernightInsights } from '../memory.js';
import config from '../config.js';
import logger from '../logger.js';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
    const todos = getActiveTodos();

    const sections = [];
    const dayName = new Date(todayStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    sections.push(`*Good morning.* ${dayName}.\n`);

    // Weather
    if (widgets?.weather?.length > 0) {
      const weatherLines = widgets.weather.map(w => `${w.location}: ${w.temp}C, ${w.description}`);
      sections.push(`*Weather*\n${weatherLines.join('\n')}`);
    }

    // Today's calendar
    if (widgets?.calendar?.length > 0) {
      const todayEvents = widgets.calendar.filter(e => {
        const start = (e.start || '').split('T')[0];
        return start === todayStr;
      });
      if (todayEvents.length > 0) {
        const lines = todayEvents.map(e => {
          const time = e.start?.includes('T')
            ? new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })
            : 'All day';
          return `  ${time} -- ${e.summary}`;
        });
        sections.push(`*Calendar* (${todayEvents.length})\n${lines.join('\n')}`);
      } else {
        sections.push('*Calendar:* Clear day.');
      }
    }

    // Side gig meetings today
    if (widgets?.sideGig?.length > 0) {
      const todayMeetings = widgets.sideGig.filter(m => {
        const start = (m.start || '').split('T')[0];
        return start === todayStr;
      });
      if (todayMeetings.length > 0) {
        const lines = todayMeetings.map(m => {
          const tags = (m.tags || []).join('/');
          const time = new Date(m.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
          return `  ${time} -- ${tags ? '[' + tags + '] ' : ''}${m.summary}`;
        });
        sections.push(`*Side gig*\n${lines.join('\n')}`);
      }
    }

    // Todos
    if (todos.length > 0) {
      const urgent = todos.filter(t => t.priority === 'high' || (t.dueDate && t.dueDate <= todayStr));
      if (urgent.length > 0) {
        sections.push(`*Urgent* (${urgent.length})\n${urgent.map(t => `  - ${t.text}`).join('\n')}`);
      }
      sections.push(`*Active todos:* ${todos.length}`);
    }

    // Next Henry weekend
    if (widgets?.henryWeekends?.length > 0) {
      const next = widgets.henryWeekends[0];
      const daysUntil = Math.ceil((new Date(next.startDate) - new Date(todayStr)) / 86400000);
      let status = `*Henry:* ${next.startDate} (${daysUntil}d)`;
      if (!next.travelBooked && next.needsTravel) status += ' -- travel NOT booked';
      if (!next.accommodationBooked && next.needsAccommodation) status += ' -- accom NOT booked';
      sections.push(status);
    }

    // Memory system status
    if (config.evoMemoryEnabled) {
      const evo = getEvoStatus();
      let memLine = `*Memory:* ${evo.online ? 'EVO online' : 'EVO offline'}`;
      if (evo.queueDepth > 0) memLine += ` | ${evo.queueDepth} queued`;
      try {
        const stats = await getMemoryStats();
        if (stats.total) memLine += ` | ${stats.total} memories`;
      } catch (err) { logger.warn({ err: err.message }, 'briefing memory stats failed'); }
      sections.push(memLine);
    }

    // Overnight insights (from last night's diary)
    if (config.evoMemoryEnabled && isEvoOnline()) {
      try {
        const yesterday = new Date(todayStr + 'T12:00:00');
        yesterday.setDate(yesterday.getDate() - 1);
        const yStr = yesterday.toISOString().split('T')[0];

        const insights = await getOvernightInsights(yStr);
        if (insights.length > 0) {
          const lines = insights
            .slice(0, 4)
            .map(m => `  - ${m.fact || m.text || m.content || '?'}`);
          sections.push(`*Overnight insights*\n${lines.join('\n')}`);
        }
      } catch (err) { logger.warn({ err: err.message }, 'briefing overnight insights failed'); }
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
