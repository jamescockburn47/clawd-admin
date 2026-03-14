// Tool execution dispatcher — routes Claude tool calls to handlers
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarFindFreeTime } from './calendar.js';
import { gmailSearch, gmailRead, gmailDraft, gmailConfirmSend } from './gmail.js';
import { searchTrains, searchAccommodation } from './travel.js';
import { trainDepartures, trainFares } from './darwin.js';
import { hotelSearch } from './amadeus.js';
import { webSearch } from './search.js';
import { soulRead, soulPropose, soulConfirm } from './soul.js';

const TOOL_MAP = {
  calendar_list_events: calendarListEvents,
  calendar_create_event: calendarCreateEvent,
  calendar_update_event: calendarUpdateEvent,
  calendar_find_free_time: calendarFindFreeTime,
  gmail_search: gmailSearch,
  gmail_read: gmailRead,
  gmail_draft: gmailDraft,
  gmail_confirm_send: gmailConfirmSend,
  train_departures: trainDepartures,
  train_fares: trainFares,
  hotel_search: hotelSearch,
  search_trains: searchTrains,
  search_accommodation: searchAccommodation,
  web_search: webSearch,
  soul_read: soulRead,
  soul_propose: soulPropose,
  soul_confirm: soulConfirm,
};

export async function executeTool(toolName, toolInput) {
  const handler = TOOL_MAP[toolName];
  if (!handler) {
    return `Unknown tool: ${toolName}`;
  }

  try {
    const result = await handler(toolInput);
    return result;
  } catch (err) {
    console.error(`[tool] ${toolName} error:`, err.message);
    return `Tool error (${toolName}): ${err.message}`;
  }
}
