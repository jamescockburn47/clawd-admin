// Tool execution dispatcher — routes Claude tool calls to handlers
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarFindFreeTime } from './calendar.js';
import { gmailSearch, gmailRead, gmailDraft, gmailConfirmSend } from './gmail.js';
import { searchTrains, searchAccommodation } from './travel.js';
import { trainDepartures, trainFares } from './darwin.js';
import { hotelSearch } from './amadeus.js';
import { webSearch } from './search.js';
import { soulRead, soulPropose, soulConfirm } from './soul.js';
import { todoAdd, todoList, todoComplete, todoRemove, todoUpdate, getAllTodos } from './todo.js';
import { searchMemory, updateMemory, deleteMemory } from '../memory.js';
import { broadcastSSE } from '../widgets.js';
import { logAudit } from '../audit.js';
import logger from '../logger.js';

const TODO_MUTATION_TOOLS = new Set(['todo_add', 'todo_complete', 'todo_remove', 'todo_update']);

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
  todo_add: todoAdd,
  todo_list: todoList,
  todo_complete: todoComplete,
  todo_remove: todoRemove,
  todo_update: todoUpdate,
  memory_search: async (input) => {
    const results = await searchMemory(input.query, input.category, 8);
    if (results.length === 0) return 'No relevant memories found.';
    return results.map(r => {
      const m = r.memory;
      return `- ${m.fact} [${m.category}, ${m.sourceDate}, confidence: ${m.confidence}] (id: ${m.id})`;
    }).join('\n');
  },
  memory_update: async (input) => {
    const result = await updateMemory(input.memory_id, {
      fact: input.fact,
      category: input.category,
      tags: input.tags,
    });
    if (result.updated) return `Memory updated: "${result.memory.fact}"`;
    if (result.offline) return 'Memory service is offline — correction noted, will apply when back online.';
    return `Failed to update memory: ${result.error || 'not found'}`;
  },
  memory_delete: async (input) => {
    const result = await deleteMemory(input.memory_id);
    if (result.deleted) return 'Memory deleted.';
    if (result.offline) return 'Memory service is offline — will delete when back online.';
    return `Failed to delete memory: ${result.error || 'not found'}`;
  },
};

// Summarise tool input for audit (truncate large payloads)
function summariseInput(input) {
  const str = JSON.stringify(input);
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

export async function executeTool(toolName, toolInput, senderJid) {
  const handler = TOOL_MAP[toolName];
  if (!handler) {
    return `Unknown tool: ${toolName}`;
  }

  try {
    const result = await handler(toolInput);

    // Audit log (fire-and-forget)
    logAudit({
      tool: toolName,
      sender: senderJid || 'dashboard',
      input: summariseInput(toolInput),
      resultLength: result.length,
      success: true,
    }).catch(() => {});

    if (TODO_MUTATION_TOOLS.has(toolName)) {
      broadcastSSE('todos', { todos: getAllTodos() });
    }
    return result;
  } catch (err) {
    logAudit({
      tool: toolName,
      sender: senderJid || 'dashboard',
      input: summariseInput(toolInput),
      error: err.message,
      success: false,
    }).catch(() => {});

    logger.error({ tool: toolName, err: err.message, sender: senderJid }, 'tool error');
    return `Tool error (${toolName}): ${err.message}`;
  }
}
