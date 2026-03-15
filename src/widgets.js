// Widget data cache for the RPi5 dashboard
// Periodically fetches Henry weekends, side gig meetings, email summary, booking status

import { google } from 'googleapis';
import config from './config.js';
import logger from './logger.js';
import { fetchAllWeather, fetchDailyForecast, extractLocation } from './weather.js';
import { CircuitBreaker } from './circuit-breaker.js';

const googleBreaker = new CircuitBreaker('google', { threshold: 3, resetTimeout: 120000 });

let authClient = null;

function getAuth() {
  if (authClient) return authClient;
  if (!config.googleClientId || !config.googleRefreshToken) return null;
  authClient = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
  authClient.setCredentials({ refresh_token: config.googleRefreshToken });
  return authClient;
}

// --- Cache ---
let widgetCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- SSE subscribers ---
const sseClients = new Set();

export function addSSEClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

export function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// --- Henry Weekend parsing ---

function parseHenryEvent(event) {
  const summary = (event.summary || '').toLowerCase();
  const description = (event.description || '').toLowerCase();
  const text = summary + ' ' + description;

  const startDate = event.start?.date || (event.start?.dateTime || '').split('T')[0];
  let endDate = event.end?.date || (event.end?.dateTime || '').split('T')[0];

  // Google Calendar all-day events use exclusive end dates (Sat-Sun event → end = Monday)
  // Subtract 1 day to get the actual last day of the event
  if (event.end?.date && !event.end?.dateTime) {
    const d = new Date(endDate + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    endDate = d.toISOString().split('T')[0];
  }

  // Determine pattern from keywords (or infer from start/end days)
  // Structured tags like [driving], [train], [4-trip] take priority
  let pattern = null;
  if (text.includes('[driving]')) {
    pattern = 'driving';
  } else if (text.includes('[4-trip]') || text.includes('[4trip]')) {
    pattern = '4-trip';
  } else if (text.includes('[train]')) {
    pattern = null; // let day-of-week inference decide fri-sun vs sat-sun
  } else if (text.includes('4-trip') || text.includes('4 trip') || text.includes('four trip')) {
    pattern = '4-trip';
  } else if (text.includes('sat-sun') || text.includes('sat - sun')) {
    pattern = 'sat-sun';
  } else if (text.includes('fri-sun') || text.includes('fri - sun')) {
    pattern = 'fri-sun';
  } else if (text.includes('driving') || text.includes('drive')) {
    pattern = 'driving';
  }

  // Infer from start/end days of week if not set by keywords
  if (!pattern && startDate && endDate) {
    const startDow = new Date(startDate + 'T12:00:00').getDay();
    const endDow = new Date(endDate + 'T12:00:00').getDay();
    if (startDow === 5) pattern = 'fri-sun';       // Friday start
    else if (startDow === 6 && endDow === 0) pattern = 'sat-sun';  // Sat-Sun
    else if (startDow === 6) pattern = 'fri-sun';   // Sat start but multi-day → likely fri-sun with travel Fri eve
    else pattern = 'fri-sun';                       // fallback
  }

  // Determine if up north (needs accommodation) or London-based (4-trip, no accommodation)
  let location = 'up-north';
  if (text.includes('london') || pattern === '4-trip') {
    location = 'london';
  }

  const needsAccommodation = location === 'up-north' && pattern !== 'driving';
  const needsTravel = pattern !== 'driving';

  return {
    summary: event.summary || 'Henry weekend',
    startDate,
    endDate,
    pattern,
    location,
    needsTravel,
    needsAccommodation,
    travelBooked: false,
    travelPrice: null,
    accommodationBooked: false,
    accommodationDetails: null,
    accommodationLocation: null,
    description: event.description || '',
    eventId: event.id,
  };
}

// --- Booking status from Gmail ---

function formatGmailDate(d) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function checkBookingStatus(weekends) {
  const auth = getAuth();
  if (!auth || weekends.length === 0) return weekends;

  const gmail = google.gmail({ version: 'v1', auth });

  // Fetch recent travel and accommodation emails in one batch each
  let travelEmails = [];
  let accomEmails = [];

  try {
    const travelRes = await gmail.users.messages.list({
      userId: 'me',
      q: '(from:lner.co.uk OR from:trainline.com OR from:nationalrail.co.uk OR subject:"e-ticket" subject:train) newer_than:90d',
      maxResults: 20,
    });
    const travelMsgs = travelRes.data.messages || [];
    for (const msg of travelMsgs.slice(0, 10)) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Subject', 'Date'],
      });
      travelEmails.push({
        subject: (detail.data.payload?.headers || []).find((h) => h.name === 'Subject')?.value || '',
        snippet: detail.data.snippet || '',
        date: (detail.data.payload?.headers || []).find((h) => h.name === 'Date')?.value || '',
      });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'travel email check error');
  }

  try {
    const accomRes = await gmail.users.messages.list({
      userId: 'me',
      q: '(from:booking.com OR from:airbnb.com OR from:airbnb.co.uk OR from:cottages.com OR from:pitchup.com OR from:canopyandstars.co.uk) newer_than:90d',
      maxResults: 20,
    });
    const accomMsgs = accomRes.data.messages || [];
    for (const msg of accomMsgs.slice(0, 10)) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Subject', 'Date'],
      });
      accomEmails.push({
        subject: (detail.data.payload?.headers || []).find((h) => h.name === 'Subject')?.value || '',
        snippet: detail.data.snippet || '',
        date: (detail.data.payload?.headers || []).find((h) => h.name === 'Date')?.value || '',
      });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'accommodation email check error');
  }

  // Try to match emails to weekends by date references in subject/snippet
  for (const weekend of weekends) {
    if (!weekend.needsTravel && !weekend.needsAccommodation) continue;

    const startD = new Date(weekend.startDate + 'T12:00:00');
    const endD = new Date(weekend.endDate + 'T12:00:00');

    // Build date patterns to search for in email text
    const datePatterns = [];
    for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
      const day = d.getDate();
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const monthFull = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const m = d.getMonth();
      const dd = String(day).padStart(2, '0');
      const mm = String(m + 1).padStart(2, '0');
      const yyyy = d.getFullYear();

      datePatterns.push(
        `${day} ${monthNames[m]}`, `${day} ${monthFull[m]}`,
        `${dd}/${mm}`, `${dd}-${mm}`,
        `${yyyy}-${mm}-${dd}`,
      );
    }

    // Check travel emails
    if (weekend.needsTravel) {
      for (const email of travelEmails) {
        const text = (email.subject + ' ' + email.snippet).toLowerCase();
        const matched = datePatterns.some((p) => text.includes(p.toLowerCase()));
        if (matched) {
          weekend.travelBooked = true;
          // Try to extract price
          const priceMatch = text.match(/£(\d+(?:\.\d{2})?)/);
          if (priceMatch) weekend.travelPrice = '£' + priceMatch[1];
          break;
        }
      }
    }

    // Check accommodation emails
    if (weekend.needsAccommodation) {
      for (const email of accomEmails) {
        const text = (email.subject + ' ' + email.snippet).toLowerCase();
        const matched = datePatterns.some((p) => text.includes(p.toLowerCase()));
        if (matched) {
          weekend.accommodationBooked = true;
          const priceMatch = text.match(/£(\d+(?:\.\d{2})?)/);
          weekend.accommodationDetails = priceMatch ? '£' + priceMatch[1] : 'Confirmed';
          // Extract location from booking email for weather forecast
          weekend.accommodationLocation = extractLocation(text);
          weekend.accommodationText = email.subject; // for debugging
          break;
        }
      }
    }

    // Also try to extract location from any accom email even if not date-matched
    // (some booking confirmations don't include dates in subject/snippet)
    if (!weekend.accommodationLocation && weekend.location === 'up-north') {
      for (const email of accomEmails) {
        const text = (email.subject + ' ' + email.snippet).toLowerCase();
        const loc = extractLocation(text);
        if (loc !== 'york') { // only if we find a specific place, not the default
          weekend.accommodationLocation = loc;
          break;
        }
      }
    }
  }

  return weekends;
}

// --- Fetch functions ---

async function fetchHenryWeekends() {
  const auth = getAuth();
  if (!auth) return [];

  const cal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  try {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      q: 'Henry',
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    });

    const events = res.data.items || [];
    const weekends = events.map(parseHenryEvent);
    return checkBookingStatus(weekends);
  } catch (err) {
    logger.error({ err: err.message }, 'Henry weekends fetch error');
    return [];
  }
}

async function fetchSideGigMeetings() {
  const auth = getAuth();
  if (!auth) return [];

  const cal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  try {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const events = res.data.items || [];

    return events
      .filter((e) => {
        const text = ((e.summary || '') + ' ' + (e.description || '')).toLowerCase();
        return /\bai\b/.test(text) || /\blq\b/.test(text) || text.includes('legal quants');
      })
      .map((e) => {
        const text = ((e.summary || '') + ' ' + (e.description || '')).toLowerCase();
        const tags = [];
        if (/\bai\b/.test(text)) tags.push('AI');
        if (/\blq\b/.test(text) || text.includes('legal quants')) tags.push('LQ');
        return {
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location || null,
          description: e.description || null,
          tags,
          eventId: e.id,
        };
      })
      .slice(0, 8);
  } catch (err) {
    logger.error({ err: err.message }, 'side gig fetch error');
    return [];
  }
}

async function fetchEmailSummary() {
  const auth = getAuth();
  if (!auth) return { unreadCount: 0, recent: [] };

  const gmail = google.gmail({ version: 'v1', auth });

  try {
    // Unread count (primary inbox only)
    const unreadRes = await gmail.users.messages.list({
      userId: 'me', q: 'is:unread is:inbox category:primary', maxResults: 1,
    });

    // Fetch 20 recent primary inbox emails (excludes promotions, social, updates, forums)
    const recentRes = await gmail.users.messages.list({
      userId: 'me', q: 'is:inbox category:primary', maxResults: 20,
    });

    const recentMsgs = (recentRes.data.messages || []).slice(0, 20);
    const recent = [];
    const threadIds = new Set();

    // Fetch message metadata
    for (const msg of recentMsgs) {
      const detail = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = detail.data.payload?.headers || [];
      const getH = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
      recent.push({
        id: msg.id,
        threadId: detail.data.threadId,
        from: getH('From'),
        subject: getH('Subject'),
        date: getH('Date'),
        snippet: detail.data.snippet || '',
        unread: (detail.data.labelIds || []).includes('UNREAD'),
        needsReply: false,
      });
      threadIds.add(detail.data.threadId);
    }

    // Check which threads need a reply (last message not from me)
    for (const threadId of threadIds) {
      try {
        const thread = await gmail.users.threads.get({
          userId: 'me', id: threadId, format: 'minimal',
        });
        const msgs = thread.data.messages || [];
        if (msgs.length > 0) {
          const lastMsg = msgs[msgs.length - 1];
          const labels = lastMsg.labelIds || [];
          // If last message in thread is SENT, user has replied
          const userReplied = labels.includes('SENT');
          if (!userReplied) {
            // Mark all emails from this thread as needs-reply
            for (const email of recent) {
              if (email.threadId === threadId) email.needsReply = true;
            }
          }
        }
      } catch (_) {
        // Thread fetch failed — skip
      }
    }

    return {
      unreadCount: unreadRes.data.resultSizeEstimate || 0,
      recent,
    };
  } catch (err) {
    logger.error({ err: err.message }, 'email summary error');
    return { unreadCount: 0, recent: [] };
  }
}

async function fetchCalendarEvents() {
  const auth = getAuth();
  if (!auth) return [];

  const cal = google.calendar({ version: 'v3', auth });
  const now = new Date();
  const future = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  try {
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 15,
    });
    return (res.data.items || []).map((e) => ({
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || null,
      description: e.description || null,
    }));
  } catch (err) {
    logger.error({ err: err.message }, 'calendar events error');
    return [];
  }
}

// --- Main refresh ---

async function refreshWidgets() {
  logger.info('widget refresh starting');
  const start = Date.now();

  // Fallback values use previous cache or empty defaults
  const prev = widgetCache || { henryWeekends: [], sideGig: [], email: { unreadCount: 0, recent: [] }, calendar: [], weather: [] };

  try {
    // Google API calls go through circuit breaker; weather has its own breaker
    const [henryWeekends, sideGig, email, calendar, weather] = await Promise.all([
      googleBreaker.call(() => fetchHenryWeekends(), () => prev.henryWeekends),
      googleBreaker.call(() => fetchSideGigMeetings(), () => prev.sideGig),
      googleBreaker.call(() => fetchEmailSummary(), () => prev.email),
      googleBreaker.call(() => fetchCalendarEvents(), () => prev.calendar),
      fetchAllWeather(),
    ]);

    // Attach weather forecasts to upcoming Henry weekends (up-north only, within 16-day forecast window)
    const now = new Date();
    const forecastLimit = new Date(now.getTime() + 16 * 24 * 60 * 60 * 1000);
    for (const weekend of henryWeekends) {
      if (weekend.location !== 'up-north' || !weekend.startDate) continue;
      const startD = new Date(weekend.startDate + 'T12:00:00');
      if (startD > forecastLimit) continue;

      // Determine location: accommodation booking > event description > event summary > default York
      const locKey = weekend.accommodationLocation
        || extractLocation((weekend.description || '') + ' ' + (weekend.summary || ''));

      // Clamp end date to forecast limit
      const endD = new Date(weekend.endDate + 'T12:00:00');
      const clampedEnd = endD > forecastLimit ? forecastLimit.toISOString().split('T')[0] : weekend.endDate;

      try {
        const forecast = await fetchDailyForecast(locKey, weekend.startDate, clampedEnd);
        if (forecast) weekend.forecast = forecast;
      } catch (err) {
        logger.warn({ err: err.message, weekend: weekend.startDate }, 'henry forecast fetch failed');
      }
    }

    widgetCache = { henryWeekends, sideGig, email, calendar, weather, lastRefresh: new Date().toISOString() };
    cacheTimestamp = Date.now();

    logger.info({ ms: Date.now() - start, henry: henryWeekends.length, gig: sideGig.length, emails: email.recent.length }, 'widget refresh done');

    // Notify dashboard clients
    broadcastSSE('widgets', widgetCache);
  } catch (err) {
    logger.error({ err: err.message }, 'widget refresh error');
  }
}

// --- Public API ---

export async function getWidgetData() {
  if (!widgetCache || Date.now() - cacheTimestamp > CACHE_TTL) {
    await refreshWidgets();
  }
  return widgetCache || {
    henryWeekends: [], sideGig: [], email: { unreadCount: 0, recent: [] },
    calendar: [], weather: [], lastRefresh: null,
  };
}

export function forceRefresh() {
  return refreshWidgets();
}

let refreshInterval = null;

export function startWidgetRefresh() {
  if (!config.googleClientId || !config.googleRefreshToken) {
    logger.warn('Google not configured - widget refresh disabled');
    return;
  }
  refreshWidgets();
  refreshInterval = setInterval(refreshWidgets, CACHE_TTL);
  logger.info('widget periodic refresh started (5 min)');
}

export function stopWidgetRefresh() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}
