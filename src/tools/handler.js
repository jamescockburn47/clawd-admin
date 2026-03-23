// Tool execution dispatcher — routes Claude tool calls to handlers
import { calendarListEvents, calendarCreateEvent, calendarUpdateEvent, calendarFindFreeTime } from './calendar.js';
import { gmailSearch, gmailRead, gmailDraft, gmailConfirmSend } from './gmail.js';
import { searchTrains, searchAccommodation } from './travel.js';
import { trainDepartures, trainFares } from './darwin.js';
import { hotelSearch } from './amadeus.js';
import { webSearch, webFetch } from './search.js';
import { soulRead, soulPropose, soulConfirm, soulLearn, soulForget } from './soul.js';
import { todoAdd, todoList, todoComplete, todoRemove, todoUpdate, getAllTodos } from './todo.js';
import { searchMemory, updateMemory, deleteMemory } from '../memory.js';
import { broadcastSSE, getSSEClientCount } from '../widgets.js';
import { logAudit } from '../audit.js';
import { getRoutingStats } from '../router-telemetry.js';
import config from '../config.js';
import logger from '../logger.js';

// Voice listener heartbeat tracking
let _lastVoiceHeartbeat = null;
export function recordVoiceHeartbeat(data) {
  _lastVoiceHeartbeat = { ...data, receivedAt: Date.now() };
}

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
  web_fetch: webFetch,
  soul_read: soulRead,
  soul_learn: soulLearn,
  soul_forget: soulForget,
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
  system_status: async () => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const mbRss = (mem.rss / 1048576).toFixed(0);

    // Check EVO health
    let evoStatus = 'unknown';
    try {
      const { checkEvoHealth } = await import('../evo-llm.js');
      evoStatus = await checkEvoHealth() ? 'online (llama-server responding)' : 'offline';
    } catch { evoStatus = 'check failed'; }

    // WhatsApp connection
    const waConnected = globalThis._clawdWhatsAppConnected || false;

    // Voice listener status (heartbeat within last 90s = online)
    let voiceStatus = 'no heartbeat received';
    if (_lastVoiceHeartbeat) {
      const ageSec = Math.round((Date.now() - _lastVoiceHeartbeat.receivedAt) / 1000);
      if (ageSec < 90) {
        const vUptime = _lastVoiceHeartbeat.uptime || 0;
        const vH = Math.floor(vUptime / 3600);
        const vM = Math.floor((vUptime % 3600) / 60);
        const ns = _lastVoiceHeartbeat.noise_suppression ? 'on' : 'off';
        const model = _lastVoiceHeartbeat.whisper_model || 'unknown';
        voiceStatus = `online (${vH}h ${vM}m), Whisper ${model}, noise suppression ${ns}`;
      } else {
        voiceStatus = `last heartbeat ${ageSec}s ago — possibly offline`;
      }
    }

    // Dashboard SSE clients
    const sseClients = getSSEClientCount();

    // Router stats
    const routerStats = getRoutingStats();
    const routerLine = routerStats.total > 0
      ? `${routerStats.local} local, ${routerStats.claude} Claude, ${routerStats.fallback} fallbacks (${routerStats.total} total today)`
      : 'no messages routed today';

    return [
      `**Pi (clawdbot)**: Running ${hours}h ${mins}m, ${mbRss}MB RSS`,
      `**WhatsApp**: ${waConnected ? 'Connected' : 'Disconnected'}`,
      `**EVO X2**: ${evoStatus}`,
      `**Voice listener**: ${voiceStatus}`,
      `**Dashboard**: ${sseClients} SSE client(s) connected`,
      `**Models**: Claude ${config.claudeModel} (cloud), ${config.evoMainModelLabel}, ${config.evoClassifierLabel}`,
      `**Routing today**: ${routerLine}`,
    ].join('\n');
  },
};

// Summarise tool input for audit (truncate large payloads)
function summariseInput(input) {
  const str = JSON.stringify(input);
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

// DM callback — set by index.js so soul proposals can be routed to owner DM
let _sendOwnerDM = null;
export function setSendOwnerDM(fn) { _sendOwnerDM = fn; }

export async function executeTool(toolName, toolInput, senderJid, chatJid) {
  const handler = TOOL_MAP[toolName];
  if (!handler) {
    return `Unknown tool: ${toolName}`;
  }

  const isGroup = chatJid && chatJid.endsWith('@g.us');

  // Soul proposals from groups must be redirected to owner DM
  if (toolName === 'soul_propose' && isGroup && _sendOwnerDM) {
    const result = await handler(toolInput);
    await _sendOwnerDM(`*Soul update proposed (from group):*\n\n${result}\n\nReply "confirm soul" to apply, or ignore to reject.`);
    return 'Proposal sent to James via DM for review. Soul changes require owner confirmation.';
  }

  // Soul confirm only works from owner DM, not groups
  if (toolName === 'soul_confirm' && isGroup) {
    return 'Soul confirmations must happen in DM with James, not in group chats.';
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
