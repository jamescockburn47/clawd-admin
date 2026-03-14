import { google } from 'googleapis';
import config from '../config.js';

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
    maxResults: 20,
    singleEvents: true,
    orderBy: 'startTime',
  };
  if (query) params.q = query;

  const res = await cal.events.list(params);
  const events = res.data.items || [];

  if (events.length === 0) return 'No upcoming events found.';

  return events.map((e) => {
    const start = e.start?.dateTime || e.start?.date;
    const end = e.end?.dateTime || e.end?.date;
    return `• ${e.summary || '(No title)'}\n  ${start} → ${end}${e.location ? '\n  📍 ' + e.location : ''}`;
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
  return `Event created: "${res.data.summary}" on ${res.data.start.dateTime || res.data.start.date}\nLink: ${res.data.htmlLink}`;
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
