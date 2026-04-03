// src/http-server.js — HTTP server and dashboard API endpoints
// Voice/chat handlers delegated to voice-handler.js.

import { createServer } from 'http';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './config.js';
import logger from './logger.js';
import { addSSEClient, broadcastSSE } from './sse.js';
import { getRecentMessages, getAllRecentMessages } from './buffer.js';
import { getUsageStats } from './claude.js';
import { checkLlamaHealth as checkEvoLlmHealth } from './evo-client.js';
import { getWidgetData, startWidgetRefresh, forceRefresh } from './widgets.js';
import { getSoulData, resetSoul } from './tools/soul.js';
import { getAllTodos, todoComplete } from './tools/todo.js';
import { getAuditLog } from './audit.js';
import { getEvoStatus, getMemoryStats, listMemories, searchMemory, storeNote, updateMemory, deleteMemory, getLastHealthData } from './memory.js';
import { getSystemHealth } from './scheduler.js';
import { getQualitySummary, getRecentFeedback } from './interaction-log.js';
import { getWorkingMemoryState } from './lquorum-rag.js';
import { handleVoiceLocal, handleVoiceCommand, handleDashboardChat } from './voice-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function checkAuth(req) {
  if (!config.dashboardToken) return true;
  const url = new URL(req.url, 'http://localhost');
  const t = url.searchParams.get('token');
  const h = req.headers.authorization;
  return (t === config.dashboardToken) || (h?.startsWith('Bearer ') && h.slice(7) === config.dashboardToken);
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b)); });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function urlPath(req) { return new URL(req.url, 'http://localhost').pathname; }

export function startHttpServer(port, deps) {
  const { getActiveSock, sendProactiveMessage, getLastActivity } = deps;

  createServer(async (req, res) => {
    const path = urlPath(req);

    if (req.method === 'POST' && path === '/api/send') {
      try {
        const { jid, message } = JSON.parse(await readBody(req));
        if (!jid || !message) return json(res, 400, { error: 'jid and message required' });
        await sendProactiveMessage(jid, message);
        json(res, 200, { ok: true });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    if (path === '/api/status') {
      const s = getActiveSock();
      return json(res, 200, { connected: !!s, name: s?.user?.name || null, jid: s?.user?.id || null, lastActivity: getLastActivity(), uptime: Math.round(process.uptime()), memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576) });
    }

    if (path === '/api/usage') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, getUsageStats());
    }
    if (path === '/api/working-memory') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, getWorkingMemoryState());
    }

    if (path === '/dashboard') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const hp = join(__dirname, '..', 'public', 'dashboard.html');
      if (existsSync(hp)) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(readFileSync(hp, 'utf-8')); }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Dashboard not found');
    }

    if (path === '/api/system-health') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const h = getSystemHealth();
        try { const ms = await getMemoryStats(); h.memory = { total: ms.total || 0, categories: ms.categories || {} }; } catch { h.memory = { total: 0, categories: {} }; }
        h.uptime = Math.round(process.uptime()); h.memoryMB = Math.round(process.memoryUsage().heapUsed / 1048576);
        return json(res, 200, h);
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/widgets') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { json(res, 200, await getWidgetData()); } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === 'POST' && path === '/api/widgets/refresh') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { await forceRefresh(); json(res, 200, await getWidgetData()); } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }

    if (path === '/api/soul') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, getSoulData());
    }
    if (req.method === 'POST' && path === '/api/soul/reset') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      await resetSoul(); return json(res, 200, { ok: true, message: 'Soul reset to defaults' });
    }
    if (req.method === 'POST' && path === '/api/soul/observe') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { addObservation } = await import('./tools/soul.js');
        const body = JSON.parse(await readBody(req));
        const obs = Array.isArray(body) ? body : [body];
        const results = []; for (const o of obs) results.push(await addObservation(o));
        return json(res, 200, { ok: true, results });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/todos') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { todos: getAllTodos() });
    }
    if (req.method === 'POST' && path === '/api/todos/complete') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { id } = JSON.parse(await readBody(req));
        if (!id) return json(res, 400, { error: 'id required' });
        const result = await todoComplete({ id });
        broadcastSSE('todos', { todos: getAllTodos() });
        return json(res, 200, { ok: true, message: result, todos: getAllTodos() });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (req.method === 'POST' && path === '/api/evolution/task') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { createTask: ct } = await import('./evolution.js');
        const body = JSON.parse(await readBody(req));
        if (!body.instruction) return json(res, 400, { error: 'instruction required' });
        return json(res, 200, { ok: true, task: ct(body.instruction, body.source || 'dream', body.priority || 'normal') });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/evolution/list') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { getEvolutionReport, loadTasks } = await import('./evolution.js');
        return json(res, 200, { report: getEvolutionReport(), tasks: loadTasks() });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (req.method === 'POST' && path === '/api/evolution/approve') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { taskId } = JSON.parse(await readBody(req));
        if (!taskId) return json(res, 400, { error: 'taskId required' });
        const { getTaskById, updateTask } = await import('./evolution.js');
        const task = getTaskById(taskId);
        if (!task) return json(res, 404, { error: 'task not found' });
        if (task.status !== 'awaiting_approval') return json(res, 400, { error: `task status is '${task.status}', expected 'awaiting_approval'` });
        updateTask(taskId, { status: 'approved' });
        const { deployApprovedTask } = await import('./evolution-executor.js');
        const result = await deployApprovedTask(task);
        updateTask(taskId, { status: 'deployed', result: `Deployed ${result.files.length} file(s)` });
        return json(res, 200, { success: true, taskId, files: result.files });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (req.method === 'POST' && path === '/api/evolution/reject') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { taskId } = JSON.parse(await readBody(req));
        if (!taskId) return json(res, 400, { error: 'taskId required' });
        const { getTaskById, updateTask } = await import('./evolution.js');
        const task = getTaskById(taskId);
        if (!task) return json(res, 404, { error: 'task not found' });
        const { rejectTask } = await import('./evolution-executor.js');
        await rejectTask(task);
        updateTask(taskId, { status: 'rejected', result: 'Rejected via API' });
        return json(res, 200, { success: true, taskId });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    if (path === '/api/messages') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      // Return merged feed from ALL chat buffers (not just owner DM)
      return json(res, 200, { messages: getAllRecentMessages(200) });
    }
    if (path === '/api/audit') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { audit: await getAuditLog(50) });
    }
    // --- Task planner diagnostics ---
    if (path === '/api/plans') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { getRecentPlans } = await import('./task-planner.js');
      return json(res, 200, { plans: getRecentPlans(20), count: getRecentPlans(20).length });
    }
    if (path.startsWith('/api/plans/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const planId = path.split('/api/plans/')[1];
      const { getPlanById } = await import('./task-planner.js');
      const plan = getPlanById(planId);
      if (!plan) return json(res, 404, { error: 'plan not found' });
      return json(res, 200, { plan });
    }
    // --- Overnight report JSON (for clawd-console) ---
    if (path.startsWith('/api/overnight-report/')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const dateStr = path.split('/api/overnight-report/')[1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return json(res, 400, { error: 'Invalid date format. Use YYYY-MM-DD.' });
      }
      const localPath = join('/tmp', `overnight-report-${dateStr}.json`);
      try {
        if (existsSync(localPath)) {
          return json(res, 200, JSON.parse(readFileSync(localPath, 'utf-8')));
        }
        return json(res, 404, { error: `No overnight report for ${dateStr}` });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // --- Trace analysis diagnostics ---
    if (path === '/api/traces') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { getLatestAnalysis } = await import('./tasks/trace-analyser.js');
      const analysis = getLatestAnalysis();
      if (!analysis) return json(res, 200, { analysis: null, message: 'No trace analysis yet — runs nightly at 3 AM' });
      return json(res, 200, { analysis });
    }
    if (path === '/api/traces/live') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { analyseTraces } = await import('./tasks/trace-analyser.js');
      return json(res, 200, { analysis: analyseTraces(1) }); // last 24h, on-demand
    }
    if (path === '/api/stats/messages') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      // Count all messages in today's conversation logs (full volume, not just Clawd-processed)
      const today = new Date().toISOString().split('T')[0];
      const logDir = join(__dirname, '..', 'data', 'conversation-logs');
      let totalMessages = 0;
      let groupCount = 0;
      const groups = {};
      try {
        const files = readdirSync(logDir).filter(f => f.startsWith(today));
        for (const f of files) {
          const lines = readFileSync(join(logDir, f), 'utf-8').trim().split('\n').filter(Boolean);
          const isGroup = f.includes('_g_us');
          if (isGroup) groupCount++;
          totalMessages += lines.length;
          const label = f.replace(`${today}_`, '').replace('.jsonl', '');
          groups[label] = lines.length;
        }
      } catch { /* intentional: log dir may not exist yet on fresh start */ }
      return json(res, 200, { date: today, totalMessages, groupCount, groups });
    }
    if (path === '/api/retrospective') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const { getLatestRetrospective } = await import('./tasks/weekly-retrospective.js');
      const retro = getLatestRetrospective();
      if (!retro) return json(res, 200, { retrospective: null, message: 'No retrospective yet — runs Sundays at 4 AM' });
      return json(res, 200, { retrospective: retro });
    }
    if (path === '/api/quality') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const days = parseInt(new URL(req.url, 'http://localhost').searchParams.get('days') || '7');
      return json(res, 200, { summary: getQualitySummary(days), recentFeedback: getRecentFeedback(20) });
    }
    if (path === '/api/evo' || path === '/api/ollama') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const evoOnline = await checkEvoLlmHealth();
      return json(res, 200, { available: evoOnline, online: evoOnline, url: config.evoLlmUrl, model: evoOnline ? 'Qwen3-VL-30B' : null });
    }

    // --- Memory endpoints ---
    if (path === '/api/memory/status') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { evo: getEvoStatus(), stats: await getMemoryStats(), health: getLastHealthData() });
    }
    if (path === '/api/memory/list') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      const m = await listMemories(); return json(res, 200, { memories: m, count: m.length });
    }
    if (req.method === 'POST' && path === '/api/memory/search') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const b = JSON.parse(await readBody(req));
        if (!b.query) return json(res, 400, { error: 'query required' });
        return json(res, 200, { results: await searchMemory(b.query, b.category, b.limit || 10) });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'POST' && path === '/api/memory/note') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const { text } = JSON.parse(await readBody(req));
        if (!text) return json(res, 400, { error: 'text required' });
        return json(res, 200, await storeNote(text, 'dashboard_note'));
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'PUT' && path.startsWith('/api/memory/mem_')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { return json(res, 200, await updateMemory(path.split('/').pop(), JSON.parse(await readBody(req)))); }
      catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'DELETE' && path.startsWith('/api/memory/mem_')) {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try { return json(res, 200, await deleteMemory(path.split('/').pop())); }
      catch (err) { return json(res, 500, { error: err.message }); }
    }

    // --- Voice / chat endpoints ---
    if (req.method === 'POST' && path === '/api/voice-local') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const r = await handleVoiceLocal(await readBody(req), { sendProactiveMessage, getActiveSock });
        return json(res, r.status, r.body);
      } catch (err) {
        logger.error({ err: err.message }, 'voice-local error');
        broadcastSSE('voice', { event: 'toast', message: 'Voice command failed' });
        return json(res, 500, { error: err.message });
      }
    }
    if (req.method === 'POST' && path === '/api/voice-command') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const r = await handleVoiceCommand(await readBody(req), { sendProactiveMessage, getActiveSock });
        return json(res, r.status, r.body);
      } catch (err) {
        broadcastSSE('voice', { event: 'error', message: err.message });
        return json(res, 500, { error: err.message });
      }
    }
    if (req.method === 'POST' && path === '/api/voice-status') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const body = JSON.parse(await readBody(req));
        if (body.event === 'heartbeat') { const { recordVoiceHeartbeat } = await import('./tools/handler.js'); recordVoiceHeartbeat(body); }
        broadcastSSE('voice', body); return json(res, 200, { ok: true });
      } catch (err) { return json(res, 500, { error: err.message }); }
    }
    if (req.method === 'POST' && path === '/api/desktop-mode') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        logger.info('desktop mode requested — killing kiosk Chromium');
        exec('touch /tmp/clawd-desktop-mode && pkill chromium', (err) => { if (err) logger.warn({ err: err.message }, 'chromium kill non-zero'); });
        json(res, 200, { ok: true, message: 'Kiosk hidden. Use Clawd Desktop shortcut to return.' });
      } catch (err) { json(res, 500, { error: err.message }); }
      return;
    }
    if (req.method === 'POST' && path === '/api/chat') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      try {
        const r = await handleDashboardChat(await readBody(req), { sendProactiveMessage, getActiveSock });
        return json(res, r.status, r.body);
      } catch (err) { return json(res, 500, { error: err.message }); }
    }

    // --- SSE ---
    if (path === '/api/events') {
      if (!checkAuth(req)) return json(res, 401, { error: 'Unauthorized' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
      addSSEClient(res); return;
    }

    // Default page
    const sock = getActiveSock();
    if (sock?.user?.id) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Connected as ${sock.user.name || 'Clawd'}</h2><p>Dashboard: <a href="/dashboard?token=${config.dashboardToken}">/dashboard</a></p></body></html>`);
    } else if (existsSync('/tmp/qr.png')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const img = readFileSync('/tmp/qr.png').toString('base64');
      res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Scan QR to link WhatsApp</h2><img src="data:image/png;base64,${img}" style="width:400px"/><p style="color:#888">Auto-refreshing every 5s</p></body></html>`);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><meta http-equiv="refresh" content="3"></head><body style="text-align:center;padding:40px;font-family:sans-serif"><h2>Waiting for QR...</h2><p style="color:#888">Auto-refreshing</p></body></html>');
    }
  }).listen(port, () => logger.info({ port }, 'HTTP server started'));

  startWidgetRefresh();
}
