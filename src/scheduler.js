// Scheduler — runs every minute, sends WhatsApp reminders for:
// 1. Todo items with reminder times that have passed
// 2. Side gig calendar meetings (30 min before)
// 3. Daily data backup (3 AM)

import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync, readFileSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDueReminders, markReminded, getActiveTodos } from './tools/todo.js';
import { getWidgetData } from './widgets.js';
import { checkEvoHealth, getEvoStatus, getMemoryStats, extractFromConversation, isEvoOnline, syncCache } from './memory.js';
import { keepEvoWarm } from './evo-llm.js';
import { runImprovementCycle } from './self-improve/cycle.js';
import { refreshSystemKnowledge } from './system-knowledge.js';
import config from './config.js';
import logger from './logger.js';

// Get London time components reliably (avoids en-GB date string parsing issues)
function getLondonTime() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { // en-CA gives YYYY-MM-DD
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    parts[type] = value;
  }
  const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
  const hours = parseInt(parts.hour, 10);
  const minutes = parseInt(parts.minute, 10);
  return { todayStr, hours, minutes, now };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const NOTIFIED_FILE = join(DATA_DIR, 'notified_meetings.json');

// --- Notified meetings (async) ---
let notifiedCache = null;

async function loadNotified() {
  if (notifiedCache) return notifiedCache;
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(NOTIFIED_FILE)) {
    notifiedCache = {};
    return notifiedCache;
  }
  try {
    notifiedCache = JSON.parse(await readFile(NOTIFIED_FILE, 'utf-8'));
  } catch {
    notifiedCache = {};
  }
  return notifiedCache;
}

async function saveNotified() {
  if (!notifiedCache) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(NOTIFIED_FILE, JSON.stringify(notifiedCache, null, 2));
}

function cleanNotified(data) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [key, ts] of Object.entries(data)) {
    if (ts < cutoff) delete data[key];
  }
  return data;
}

let sendFn = null;
let lastCacheSyncMinute = null;

export function initScheduler(sendMessage) {
  sendFn = sendMessage;
  runScheduler();
  setInterval(runScheduler, 60 * 1000);
  logger.info('scheduler started (60s interval)');
}

async function runScheduler() {
  try {
    // Check EVO health first — briefing and other tasks read cached status
    if (config.evoMemoryEnabled) {
      await checkEvoHealth().catch(() => {});
    }
    await checkTodoReminders();
    await checkSideGigMeetings();
    await checkMorningBriefing();
    await checkWeeklyReview();
    await checkOvernightExtraction();
    await checkSelfImprovement();
    await checkSystemKnowledgeRefresh();
    await checkDailyBackup();
    if (config.evoMemoryEnabled) {
      // Sync cache every 30 minutes
      if (isEvoOnline() && lastCacheSyncMinute !== null) {
        const { minutes } = getLondonTime();
        if (minutes % 30 === 0 && lastCacheSyncMinute !== minutes) {
          lastCacheSyncMinute = minutes;
          syncCache().catch(() => {});
        }
      }
    }
    // Keep EVO X2 tool model warm every 10 minutes
    if (config.evoToolEnabled) {
      const { minutes } = getLondonTime();
      if (minutes % 10 === 0) {
        keepEvoWarm().catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'scheduler error');
  }
}

async function checkTodoReminders() {
  if (!sendFn) return;
  const due = getDueReminders();
  for (const todo of due) {
    const msg = `*Reminder:* ${todo.text}${todo.dueDate ? '\nDue: ' + todo.dueDate : ''}`;
    try {
      await sendFn(msg);
      markReminded(todo.id);
      logger.info({ todo: todo.text }, 'reminder sent');
    } catch (err) {
      logger.error({ todo: todo.text, err: err.message }, 'reminder send failed');
    }
  }
}

async function checkSideGigMeetings() {
  if (!sendFn) return;
  const notified = cleanNotified(await loadNotified());
  const now = new Date();

  try {
    const widgets = await getWidgetData();
    if (!widgets || !widgets.sideGig) return;

    for (const meeting of widgets.sideGig) {
      if (!meeting.start) continue;
      const meetingTime = new Date(meeting.start);
      const minsUntil = (meetingTime - now) / 60000;

      if (minsUntil > 0 && minsUntil <= 35 && minsUntil >= 25) {
        const key = meeting.eventId || meeting.summary + '_' + meeting.start;
        if (notified[key]) continue;

        const tags = (meeting.tags || []).join('/');
        const time = meetingTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
        let msg = `*${tags ? '[' + tags + '] ' : ''}${meeting.summary}* in 30 minutes (${time})`;
        if (meeting.location) msg += `\n${meeting.location}`;

        try {
          await sendFn(msg);
          notified[key] = Date.now();
          await saveNotified();
          logger.info({ meeting: meeting.summary }, 'meeting reminder sent');
        } catch (err) {
          logger.error({ meeting: meeting.summary, err: err.message }, 'meeting reminder failed');
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'side gig check error');
  }
}

// --- Morning briefing ---
let lastBriefingDate = null;

async function checkMorningBriefing() {
  if (!config.briefingEnabled || !sendFn) return;

  const { todayStr, hours, minutes } = getLondonTime();

  if (lastBriefingDate === todayStr) return;

  const [targetH, targetM] = config.briefingTime.split(':').map(Number);
  if (hours < targetH || (hours === targetH && minutes < targetM)) return;
  // Don't send if we're more than 2 hours past the target time (prevents catch-up on evening restarts)
  const minutesSinceTarget = (hours - targetH) * 60 + (minutes - targetM);
  if (minutesSinceTarget > 120) return;

  lastBriefingDate = todayStr;

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
      } catch {}
      sections.push(memLine);
    }

    const briefing = sections.join('\n\n');
    await sendFn(briefing);
    logger.info('morning briefing sent');
  } catch (err) {
    logger.error({ err: err.message }, 'morning briefing failed');
  }
}

// --- Weekly memory review (Sunday 8pm) ---
let lastReviewDate = null;

async function checkWeeklyReview() {
  if (!config.evoMemoryEnabled || !sendFn) return;

  const { todayStr, hours } = getLondonTime();
  const dayOfWeek = new Date(todayStr + 'T12:00:00').getDay(); // 0 = Sunday

  if (dayOfWeek !== 0) return;
  if (lastReviewDate === todayStr) return;
  if (hours < 20 || hours > 21) return;

  lastReviewDate = todayStr;

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

// --- Overnight batch extraction (2 AM) ---
let lastExtractionDate = null;

async function checkOvernightExtraction() {
  if (!config.evoMemoryEnabled || !isEvoOnline()) return;

  const { todayStr, hours } = getLondonTime();

  if (lastExtractionDate === todayStr) return;
  if (hours !== 2) return;

  lastExtractionDate = todayStr;

  try {
    // Read conversation logs from yesterday
    const yesterday = new Date(todayStr + 'T12:00:00');
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];

    const logDir = join(__dirname, '..', 'data', 'conversation-logs');
    if (!existsSync(logDir)) return;

    const files = (await readdir(logDir)).filter(f => f.startsWith(yStr) && f.endsWith('.jsonl'));
    if (files.length === 0) return;

    let totalExtracted = 0;

    for (const file of files) {
      try {
        const content = await readFile(join(logDir, file), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        if (lines.length < 2) continue;

        // Build conversation text from log entries
        const messages = lines.map(line => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);

        const convText = messages.map(m =>
          `${m.sender || (m.isBot ? 'Clawd' : 'User')}: ${m.text}`
        ).join('\n');

        if (convText.length < 50) continue;

        const result = await extractFromConversation(convText, `conversation_${yStr}`);
        if (result.extracted) totalExtracted += result.extracted.length;
      } catch (err) {
        logger.error({ file, err: err.message }, 'extraction from log failed');
      }
    }

    if (totalExtracted > 0) {
      logger.info({ date: yStr, extracted: totalExtracted }, 'overnight extraction complete');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'overnight extraction failed');
  }
}

// --- Self-improvement cycle (runs at 1 AM) ---
let lastSelfImproveDate = null;

async function checkSelfImprovement() {
  if (!config.evoToolEnabled) return;

  const { todayStr, hours } = getLondonTime();

  if (lastSelfImproveDate === todayStr) return;
  if (hours !== 1) return;

  lastSelfImproveDate = todayStr;

  try {
    logger.info('self-improve: starting nightly cycle');
    await runImprovementCycle(sendFn);
  } catch (err) {
    logger.error({ err: err.message }, 'self-improve: nightly cycle failed');
  }
}

// --- System knowledge refresh (runs at 2 AM) ---
let lastKnowledgeRefreshDate = null;

async function checkSystemKnowledgeRefresh() {
  if (!config.evoMemoryEnabled) return;

  const { todayStr, hours } = getLondonTime();

  if (lastKnowledgeRefreshDate === todayStr) return;
  if (hours !== 2) return;

  lastKnowledgeRefreshDate = todayStr;

  try {
    logger.info('system-knowledge: starting nightly refresh');
    const result = await refreshSystemKnowledge();
    if (result.refreshed) {
      logger.info({ deleted: result.deleted, seeded: result.seeded, elapsed: result.elapsed }, 'system-knowledge: nightly refresh complete');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'system-knowledge: nightly refresh failed');
  }
}

// --- Daily backup (runs at 3 AM) ---
let lastBackupDate = null;

async function checkDailyBackup() {
  const { todayStr, hours } = getLondonTime();

  if (lastBackupDate === todayStr) return;
  if (hours !== 3) return;

  lastBackupDate = todayStr;

  const backupDir = join(DATA_DIR, 'backups', todayStr);
  await mkdir(backupDir, { recursive: true });

  const filesToBackup = ['todos.json', 'soul.json', 'soul_history.json'];
  let count = 0;

  for (const file of filesToBackup) {
    const src = join(DATA_DIR, file);
    if (existsSync(src)) {
      try {
        const data = await readFile(src);
        await writeFile(join(backupDir, file), data);
        count++;
      } catch (err) {
        logger.error({ file, err: err.message }, 'backup file failed');
      }
    }
  }

  // Clean old backups (keep last 7)
  try {
    const backupsRoot = join(DATA_DIR, 'backups');
    const dirs = (await readdir(backupsRoot)).sort();
    while (dirs.length > 7) {
      const old = dirs.shift();
      await rm(join(backupsRoot, old), { recursive: true, force: true });
    }
  } catch {}

  if (count > 0) {
    logger.info({ date: todayStr, files: count }, 'daily backup complete');
  }
}
