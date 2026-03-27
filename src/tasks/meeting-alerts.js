// Task: Side gig meeting 30-min alerts

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getWidgetData } from '../widgets.js';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', '..', 'data');
const NOTIFIED_FILE = join(DATA_DIR, 'notified_meetings.json');

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

/**
 * Check for upcoming side gig meetings and send 30-min alerts.
 * @param {Function} sendFn - WhatsApp send function
 */
export async function checkSideGigMeetings(sendFn) {
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
