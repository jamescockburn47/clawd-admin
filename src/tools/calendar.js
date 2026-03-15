import { google } from 'googleapis';
import config from '../config.js';
import { forceRefresh } from '../widgets.js';

let calendarClient = null;

function getCalendar() {
  if (calendarClient) return calendarClient;
  if (!config.googleClientId || !config.googleRefreshToken) {
    throw new Error('Google Calendar not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in .env');
  }

  const oauth2 = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
  );
  oauth2.setCredentials({ refresh_token: config.googleRefreshToken });

  calendarClient = google.calendar({ version: 'v3', auth: oauth2 });
  return calendarClient;
}

export async function calendarListEvents({ days_ahead = 7, query }) {
  const cal = getCalendar();
  const now = new Date();
  const future = new Date(now.getTime() + days_ahead * 24 * 60 * 60 * 1000);

  const params = {
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  };
  if (query) params.q = query;

  const res = await cal.events.list(params);
  const events = res.data.items || [];

  if (events.length === 0) return 'No upcoming events found.';

  // Deduplicate multi-day all-day events — Google expands them into one instance per day
  // Group by recurring event ID or by (summary + all-day), keep first/last date
  const seen = new Map();
  const output = [];

  for (const e of events) {
    const isAllDay = !!e.start?.date && !e.start?.dateTime;
    const recurKey = e.recurringEventId || (isAllDay ? `allday:${e.summary}` : null);

    if (recurKey && seen.has(recurKey)) {
      // Extend the end date of the already-seen event
      const existing = seen.get(recurKey);
      const thisEnd = e.end?.date || e.end?.dateTime;
      existing.endRaw = thisEnd;
      continue;
    }

    const start = e.start?.dateTime || e.start?.date;
    let end = e.end?.dateTime || e.end?.date;

    const entry = { summary: e.summary, start, endRaw: end, isAllDay, location: e.location, id: e.id };
    if (recurKey) seen.set(recurKey, entry);
    output.push(entry);
  }

  return output.map((e) => {
    let end = e.endRaw;
    // Google Calendar all-day events use exclusive end dates — subtract 1 day
    if (e.isAllDay && end) {
      const d = new Date(end + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      end = d.toISOString().split('T')[0];
    }
    return `• ${e.summary || '(No title)'}\n  ${e.start} → ${end}${e.location ? '\n  📍 ' + e.location : ''}\n  id: ${e.id}`;
  }).join('\n\n');
}

export async function calendarCreateEvent({ summary, start, end, description, location }) {
  const cal = getCalendar();

  const startDT = new Date(start);
  const endDT = end ? new Date(end) : new Date(startDT.getTime() + 60 * 60 * 1000);

  const event = {
    summary,
    start: { dateTime: startDT.toISOString(), timeZone: 'Europe/London' },
    end: { dateTime: endDT.toISOString(), timeZone: 'Europe/London' },
  };
  if (description) event.description = description;
  if (location) event.location = location;

  const res = await cal.events.insert({ calendarId: 'primary', resource: event });
  // Refresh dashboard widgets so calendar changes appear immediately
  forceRefresh().catch(() => {});
  return `Event created: "${res.data.summary}" on ${res.data.start.dateTime || res.data.start.date}\nLink: ${res.data.htmlLink}`;
}

export async function calendarUpdateEvent({ event_id, summary, start, end, description, location }) {
  const cal = getCalendar();

  // Fetch existing event first
  const existing = await cal.events.get({ calendarId: 'primary', eventId: event_id });
  const patch = {};

  if (summary !== undefined) patch.summary = summary;
  if (description !== undefined) patch.description = description;
  if (location !== undefined) patch.location = location;

  if (start !== undefined) {
    const startDT = new Date(start);
    // Detect all-day format (YYYY-MM-DD without time)
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      patch.start = { date: start };
    } else {
      patch.start = { dateTime: startDT.toISOString(), timeZone: 'Europe/London' };
    }
  }
  if (end !== undefined) {
    const endDT = new Date(end);
    if (/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      patch.end = { date: end };
    } else {
      patch.end = { dateTime: endDT.toISOString(), timeZone: 'Europe/London' };
    }
  }

  const res = await cal.events.patch({
    calendarId: 'primary',
    eventId: event_id,
    resource: patch,
  });
  // Refresh dashboard widgets so calendar changes appear immediately
  forceRefresh().catch(() => {});
  let updatedEnd = res.data.end.dateTime || res.data.end.date;
  // Correct exclusive end date for all-day events
  if (res.data.end.date && !res.data.end.dateTime) {
    const d = new Date(updatedEnd + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    updatedEnd = d.toISOString().split('T')[0];
  }
  return `Event updated: "${res.data.summary}" — ${res.data.start.dateTime || res.data.start.date} → ${updatedEnd}\nLink: ${res.data.htmlLink}`;
}

export async function calendarFindFreeTime({ date, days = 1 }) {
  const cal = getCalendar();
  const start = new Date(date + 'T00:00:00');
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = res.data.items || [];
  if (events.length === 0) return `${date}: Completely free all day.`;

  const busy = events.map((e) => {
    const s = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'all day';
    const en = e.end?.dateTime ? new Date(e.end.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    return `  ${s}${en ? '–' + en : ''}: ${e.summary}`;
  });

  return `${date} — ${events.length} event(s):\n${busy.join('\n')}`;
}
