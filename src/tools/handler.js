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
import { projectList, projectRead, projectPitch, projectUpdate } from './projects.js';
import { sendOvernightReport } from '../overnight-report.js';
import { createTask, getTaskSummary } from '../evolution.js';
import { getGroupConfig, setGroupConfig, removeGroupConfig, getRegisteredGroups, getSecurityLevel, getSecurityLevelInfo, getAllSecurityLevels } from '../group-registry.js';
import { broadcastSSE, getSSEClientCount } from '../sse.js';
import { logAudit } from '../audit.js';
import { getRoutingStats } from '../router-telemetry.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../logger.js';

// Hard owner check — code-level, not prompt-level
function isOwnerSender(senderJid) {
  if (!senderJid) return false;
  const ownerJids = new Set();
  if (config.ownerJid) ownerJids.add(config.ownerJid);
  if (config.ownerLid) ownerJids.add(config.ownerLid);
  return ownerJids.has(senderJid);
}

// Pending evolution confirmations: Map<confirmId, { instruction, priority, expiresAt }>
const _pendingEvolution = new Map();

export function confirmEvolutionTask(confirmId) {
  const pending = _pendingEvolution.get(confirmId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    _pendingEvolution.delete(confirmId);
    return null;
  }
  _pendingEvolution.delete(confirmId);
  return createTask(pending.instruction, 'whatsapp', pending.priority);
}

// Voice listener heartbeat tracking
let _lastVoiceHeartbeat = null;
export function recordVoiceHeartbeat(data) {
  _lastVoiceHeartbeat = { ...data, receivedAt: Date.now() };
}

// WhatsApp send function — set by index.js for tools that need to push messages
let _sendWhatsApp = null;
export function setSendWhatsApp(fn) { _sendWhatsApp = fn; }

// Document send function — set by index.js for sending file attachments
let _sendDocument = null;
export function setSendDocument(fn) { _sendDocument = fn; }
export function getSendDocument() { return _sendDocument; }

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
      const { checkLlamaHealth } = await import('../evo-client.js');
      evoStatus = await checkLlamaHealth() ? 'online (llama-server responding)' : 'offline';
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
  project_list: projectList,
  project_read: projectRead,
  project_pitch: projectPitch,
  project_update: projectUpdate,
  overnight_report: async (input) => {
    if (!_sendWhatsApp) return 'WhatsApp send function not available — cannot deliver report.';
    try {
      const dateStr = input.date || null;
      await sendOvernightReport(_sendWhatsApp, dateStr);
      return `Overnight report ${dateStr ? 'for ' + dateStr : 'for yesterday'} generated and sent.`;
    } catch (err) {
      return `Failed to generate overnight report: ${err.message}`;
    }
  },
  send_file: async (input) => {
    const docSender = _sendDocument;
    if (!docSender) return 'Document send function not available — WhatsApp not connected.';
    const safeFilename = (input.filename || '').replace(/[\/\\]/g, '');
    if (!safeFilename) return 'No filename provided.';
    const filePath = join('data', safeFilename);
    if (!existsSync(filePath)) return `File not found: data/${safeFilename}`;
    try {
      const buffer = readFileSync(filePath);
      const ext = safeFilename.split('.').pop().toLowerCase();
      const mimeMap = { pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', md: 'text/markdown', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      const mimetype = mimeMap[ext] || 'application/octet-stream';
      await docSender(buffer, safeFilename, mimetype, input.caption || '');
      return `Sent ${safeFilename} (${(buffer.length / 1024).toFixed(1)} KB)`;
    } catch (err) {
      logger.error({ err: err.message, file: safeFilename }, 'send_file failed');
      return `Failed to send file: ${err.message}`;
    }
  },
  // evolution_task is handled specially in executeTool — hard-gated, DM confirmation required.
  // This handler should never be called directly.
  evolution_task: async () => {
    return 'Evolution tasks require DM confirmation. This should not have been called directly.';
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

  // ── HARD GATE: evolution_task ──────────────────────────────────────────────
  // Code-level enforcement: only owner can trigger, and even then requires
  // explicit DM confirmation before the task is actually created.
  if (toolName === 'evolution_task') {
    // 1. Non-owner → absolute block
    if (!isOwnerSender(senderJid)) {
      logger.warn({ senderJid, tool: toolName }, 'evolution_task blocked: non-owner');
      return 'Evolution tasks can only be created by James. This request has been blocked.';
    }

    // 2. Owner → queue for DM confirmation, don't create yet
    const { randomBytes: rb } = await import('crypto');
    const confirmId = rb(4).toString('hex');
    _pendingEvolution.set(confirmId, {
      instruction: toolInput.instruction,
      priority: toolInput.priority || 'normal',
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min expiry
    });

    if (_sendOwnerDM) {
      await _sendOwnerDM(
        `*EVOLUTION TASK — Confirm to queue*\n\n` +
        `Instruction: ${toolInput.instruction}\n` +
        `Priority: ${toolInput.priority || 'normal'}\n\n` +
        `Reply "confirm evolution ${confirmId}" to approve.\n` +
        `Expires in 10 minutes. Ignoring = rejected.`
      );
    }

    logger.info({ confirmId, instruction: toolInput.instruction.slice(0, 100) }, 'evolution_task: awaiting DM confirmation');
    return 'Evolution task sent to James via DM for confirmation. It will only be queued after explicit approval.';
  }

  // Soul learn from groups must be redirected to proposal flow — only owner DM allows direct writes
  if (toolName === 'soul_learn' && isGroup && _sendOwnerDM) {
    const proposal = await soulPropose({ section: toolInput.section, content: toolInput.text, reason: 'learned from group conversation' });
    await _sendOwnerDM(`*Soul update proposed (from group):*\n\n${proposal}\n\nReply "confirm soul" to apply, or ignore to reject.`);
    return 'Proposal sent to James via DM for review. Soul changes require owner confirmation.';
  }

  // Soul forget from groups must be confirmed by owner DM
  if (toolName === 'soul_forget' && isGroup && _sendOwnerDM) {
    await _sendOwnerDM(`*Soul deletion requested (from group):*\n\nSection: ${toolInput.section}, Entry #${toolInput.index}\n\nReply "forget soul ${toolInput.section} ${toolInput.index}" in DM to confirm.`);
    return 'Deletion request sent to James via DM for review. Soul changes require owner confirmation.';
  }

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

  // ── GROUP SECURITY LEVEL TOOLS ────────────────────────────────────────────
  if (toolName === 'group_security') {
    if (!isOwnerSender(senderJid)) {
      return 'Only James can set group security levels.';
    }
    if (!isGroup) {
      return 'This tool only works in group chats. Send the command in the group you want to configure.';
    }
    const level = Math.max(1, Math.min(10, Math.round(toolInput.level)));
    const levelInfo = getSecurityLevelInfo(level);
    const update = { securityLevel: level };
    if (toolInput.label) update.label = toolInput.label;
    if (toolInput.blocked_topics) update.blockedTopics = toolInput.blocked_topics;
    setGroupConfig(chatJid, update);
    return `Security level set to ${level} (${levelInfo.name}). ${levelInfo.description}`;
  }

  if (toolName === 'group_security_status') {
    if (!isGroup) {
      // In DM, show all registered groups
      const groups = getRegisteredGroups();
      if (groups.length === 0) return 'No groups registered. Unregistered groups default to security level 3 (Standard).';
      const lines = groups.map(g => {
        const info = getSecurityLevelInfo(g.securityLevel);
        const topics = g.blockedTopics.length > 0 ? `\n  Extra blocked: ${g.blockedTopics.join(', ')}` : '';
        return `*${g.label || 'Unnamed'}* — Level ${g.securityLevel} (${info.name})${topics}`;
      });
      return lines.join('\n\n') + '\n\nUnregistered groups default to level 3 (Standard).';
    }
    const level = getSecurityLevel(chatJid);
    const info = getSecurityLevelInfo(level);
    const cfg = getGroupConfig(chatJid);
    const registered = cfg ? 'Registered' : 'Unregistered (using default)';
    const topics = cfg?.blockedTopics?.length > 0 ? `\nExtra blocked topics: ${cfg.blockedTopics.join(', ')}` : '';
    return `${registered} — Security level ${level} (${info.name})\n${info.description}${topics}`;
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
