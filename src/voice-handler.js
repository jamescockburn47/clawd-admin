// src/voice-handler.js — Voice command handlers for the HTTP API
// Handles /api/voice-local, /api/voice-command, and dashboard chat endpoints.

import config from './config.js';
import logger from './logger.js';
import { broadcastSSE } from './sse.js';
import { pushMessage, buildContext } from './buffer.js';
import { getClawdResponse, getLastToolsCalled } from './claude.js';
import { getWidgetData, forceRefresh } from './widgets.js';
import { getAllTodos, getActiveTodos, todoComplete, todoAdd } from './tools/todo.js';
import { storeNote } from './memory.js';
import { logInteraction } from './interaction-log.js';

// --- Panel detection for voice responses ---

function detectPanels(text) {
  const lc = text.toLowerCase();
  const panels = [];
  if (/\b(calendar|schedule|meeting|event|appointment|diary|tomorrow|today)\b/.test(lc)) panels.push('calendar');
  if (/\b(todo|task|reminder|to.do|shopping)\b/.test(lc)) panels.push('todos');
  if (/\b(email|inbox|gmail|message|draft|send)\b/.test(lc)) panels.push('email');
  if (/\b(weather|rain|temperature|forecast|sun)\b/.test(lc)) panels.push('weather');
  if (/\b(henry|weekend|custody)\b/.test(lc)) panels.push('henry');
  if (/\b(train|travel|hotel|fare|depart)\b/.test(lc)) panels.push('travel');
  return panels;
}

/**
 * Handle /api/voice-local — fast locally-routed voice commands (no Claude call).
 * Returns { status, body } for the HTTP response.
 */
export async function handleVoiceLocal(rawBody, { sendProactiveMessage, getActiveSock }) {
  const { action, params = {}, text, tier } = JSON.parse(rawBody);
  if (!action) return { status: 400, body: { error: 'action required' } };

  logger.info({ action, params, text, tier }, 'voice-local command');

  let message = '';
  let data = null;

  switch (action) {
    case 'navigate': {
      const panel = params.panel || 'todos';
      broadcastSSE('voice', { event: 'navigate', panel });
      broadcastSSE('voice', { event: 'toast', message: `Showing ${panel}` });
      message = `Navigated to ${panel}`;
      break;
    }

    case 'todo_add': {
      const todoText = params.text || text;
      if (!todoText) return { status: 400, body: { error: 'text required for todo_add' } };
      const result = await todoAdd({ text: todoText, priority: params.priority || 'normal', due_date: params.due_date, reminder: params.reminder });
      broadcastSSE('voice', { event: 'toast', message: `Added: ${todoText}` });
      broadcastSSE('todos', { todos: getAllTodos() });
      message = result;
      break;
    }

    case 'todo_complete': {
      const searchText = (params.text || text || '').toLowerCase();
      if (!searchText) return { status: 400, body: { error: 'text required for todo_complete' } };
      const activeTodos = getActiveTodos();
      let bestMatch = null;
      let bestScore = -1;
      for (const todo of activeTodos) {
        const todoLower = todo.text.toLowerCase();
        if (todoLower.includes(searchText) || searchText.includes(todoLower)) {
          const score = todoLower === searchText ? 3 : todoLower.includes(searchText) ? 2 : 1;
          if (score > bestScore) {
            bestScore = score;
            bestMatch = todo;
          }
        }
      }
      if (!bestMatch) {
        const searchTokens = searchText.split(/\s+/);
        for (const todo of activeTodos) {
          const todoLower = todo.text.toLowerCase();
          const overlap = searchTokens.filter(t => todoLower.includes(t)).length;
          if (overlap > bestScore) {
            bestScore = overlap;
            bestMatch = todo;
          }
        }
      }
      if (!bestMatch) {
        message = `No matching todo found for: "${params.text || text}"`;
        broadcastSSE('voice', { event: 'toast', message: 'No matching todo found' });
      } else {
        const result = await todoComplete({ id: bestMatch.id });
        broadcastSSE('voice', { event: 'toast', message: `Done: ${bestMatch.text}` });
        broadcastSSE('todos', { todos: getAllTodos() });
        message = result;
      }
      break;
    }

    case 'calendar_list': {
      const widgets = await getWidgetData();
      data = widgets.calendar || [];
      broadcastSSE('voice', { event: 'info', data });
      if (data.length === 0) {
        message = 'Nothing coming up';
      } else {
        const lines = data.slice(0, 5).map(ev => {
          const title = ev.summary || ev.title || 'Event';
          const when = ev.when || ev.start || '';
          return when ? `${title}, ${when}` : title;
        });
        message = lines.join('. ');
        if (data.length > 5) message += `. Plus ${data.length - 5} more`;
      }
      break;
    }

    case 'remember': {
      const noteText = params.text || text;
      if (!noteText) return { status: 400, body: { error: 'text required for remember' } };
      const result = await storeNote(noteText, 'voice_note');
      broadcastSSE('voice', { event: 'toast', message: 'Noted' });
      message = result.stored === false ? 'Queued for memory' : 'Stored in memory';
      data = result;
      break;
    }

    case 'refresh': {
      await forceRefresh();
      const freshData = await getWidgetData();
      broadcastSSE('voice', { event: 'toast', message: 'Refreshed' });
      message = 'Dashboard refreshed';
      data = { lastRefresh: freshData.lastRefresh };
      break;
    }

    case 'status': {
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const mbRss = (mem.rss / 1048576).toFixed(0);
      const sock = getActiveSock();
      const statusMsg = `Running for ${hours}h ${mins}m. Memory: ${mbRss}MB. WhatsApp: ${sock ? 'connected' : 'disconnected'}.`;
      broadcastSSE('voice', { event: 'response', text: statusMsg, command: text, panel: 'admin' });
      message = statusMsg;
      break;
    }

    case 'claude': {
      const jid = config.ownerJid || 'dashboard';
      const cmdText = params.text || text;
      if (!cmdText) return { status: 400, body: { error: 'text required for claude action' } };

      pushMessage(jid, { senderName: 'James (voice)', text: cmdText, hasImage: false, isBot: false });
      broadcastSSE('message', { sender: 'James (voice)', text: cmdText, timestamp: Date.now() });
      broadcastSSE('voice', { event: 'command', text: cmdText });

      const context = buildContext(jid, cmdText);
      const response = await getClawdResponse(context, 'direct', config.ownerJid, null, config.ownerJid);

      if (response) {
        pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
        broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });
        const panels = detectPanels(cmdText + ' ' + response);
        broadcastSSE('voice', { event: 'response', text: response, panels, panel: panels[0], command: cmdText });

        const sock = getActiveSock();
        if (config.ownerJid && sock) {
          try { await sendProactiveMessage(config.ownerJid, response); } catch {}
        }

        return { status: 200, body: { ok: true, action: 'claude', message: response, data: { panels } } };
      } else {
        broadcastSSE('voice', { event: 'no_result' });
        return { status: 200, body: { ok: true, action: 'claude', message: 'No response', data: null } };
      }
    }

    default:
      return { status: 400, body: { error: `Unknown action: ${action}` } };
  }

  return { status: 200, body: { ok: true, action, message, data } };
}

/**
 * Handle /api/voice-command — transcribed voice command from wake listener.
 * Returns { status, body } for the HTTP response.
 */
export async function handleVoiceCommand(rawBody, { sendProactiveMessage, getActiveSock }) {
  const { text, source } = JSON.parse(rawBody);
  if (!text) return { status: 400, body: { error: 'text required' } };

  logger.info({ text, source }, 'voice command received');
  const voiceStart = Date.now();
  const jid = config.ownerJid || 'dashboard';
  pushMessage(jid, { senderName: 'James (voice)', text, hasImage: false, isBot: false });
  broadcastSSE('message', { sender: 'James (voice)', text, timestamp: Date.now() });
  broadcastSSE('voice', { event: 'command', text });

  const context = buildContext(jid, text);
  const response = await getClawdResponse(context, 'direct', config.ownerJid, null, config.ownerJid);

  if (response) {
    pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
    broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });
    const panels = detectPanels(text + ' ' + response);
    broadcastSSE('voice', { event: 'response', text: response, panels, panel: panels[0], command: text });

    logInteraction({
      sender: { name: 'James', jid },
      source: 'voice',
      input: { text, hadImage: false },
      routing: { mode: 'direct', source: source || 'wake_word' },
      toolsCalled: getLastToolsCalled(),
      response: { text: response, chars: response.length },
      latencyMs: Date.now() - voiceStart,
      messageIds: [],
    });

    const sock = getActiveSock();
    if (config.ownerJid && sock) {
      try {
        await sendProactiveMessage(config.ownerJid, response);
      } catch (err) {
        logger.error({ err: err.message }, 'voice command WhatsApp relay failed');
      }
    }

    return { status: 200, body: { response, panels } };
  } else {
    broadcastSSE('voice', { event: 'no_result' });
    return { status: 200, body: { response: null } };
  }
}

/**
 * Handle /api/chat — dashboard chat messages.
 * Returns { status, body } for the HTTP response.
 */
export async function handleDashboardChat(rawBody, { sendProactiveMessage, getActiveSock }) {
  const { message } = JSON.parse(rawBody);
  if (!message) return { status: 400, body: { error: 'message required' } };

  const jid = config.ownerJid || 'dashboard';
  pushMessage(jid, { senderName: 'James', text: message, hasImage: false, isBot: false });
  broadcastSSE('message', { sender: 'James', text: message, timestamp: Date.now() });

  const context = buildContext(jid, message);
  const response = await getClawdResponse(context, 'direct', config.ownerJid, null, config.ownerJid);

  if (response) {
    pushMessage(jid, { senderName: 'Clawd', text: response, hasImage: false, isBot: true });
    broadcastSSE('message', { sender: 'Clawd', text: response, timestamp: Date.now() });

    const sock = getActiveSock();
    if (config.ownerJid && sock) {
      try {
        await sendProactiveMessage(config.ownerJid, response);
      } catch (err) {
        logger.error({ err: err.message }, 'dashboard WhatsApp relay failed');
      }
    }

    return { status: 200, body: { response } };
  } else {
    return { status: 200, body: { response: null } };
  }
}
