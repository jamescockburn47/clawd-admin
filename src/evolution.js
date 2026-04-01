// src/evolution.js — Evolution task store and approval flow
//
// Manages the queue of coding tasks that Claude Code CLI executes on EVO.
// Tasks arrive via WhatsApp (evolution_task tool) or dream mode analysis.
// All changes require James's explicit DM approval before deployment.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TASKS_FILE = join(__dirname, '..', 'data', 'evolution-tasks.json');

const MAX_TASKS_PER_DAY = 3;
const MIN_TASK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between tasks

// ── Task CRUD ───────────────────────────────────────────────────────────────

function loadTasks() {
  if (!existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
}

export function createTask(instruction, source = 'whatsapp', priority = 'normal') {
  const tasks = loadTasks();
  const id = `evo_${randomBytes(4).toString('hex')}`;
  const slug = instruction
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');

  const task = {
    id,
    source,
    instruction,
    priority,
    status: 'pending',
    created: new Date().toISOString(),
    branch: `evo/${slug}`,
    diff_summary: null,
    diff_detail: null,
    approval_message_id: null,
    result: null,
    files_changed: [],
  };

  tasks.push(task);
  saveTasks(tasks);
  logger.info({ taskId: id, source, instruction: instruction.slice(0, 100) }, 'evolution task created');
  return task;
}

export function getNextPending() {
  const tasks = loadTasks();
  // Priority sort: high first, then by creation date
  return tasks
    .filter(t => t.status === 'pending')
    .sort((a, b) => {
      if (a.priority === 'high' && b.priority !== 'high') return -1;
      if (b.priority === 'high' && a.priority !== 'high') return 1;
      return new Date(a.created) - new Date(b.created);
    })[0] || null;
}

export function updateTask(id, updates) {
  const tasks = loadTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  Object.assign(tasks[idx], updates);
  saveTasks(tasks);
  logger.info({ taskId: id, updates: Object.keys(updates) }, 'evolution task updated');
  return tasks[idx];
}

export function getAwaitingApproval() {
  return loadTasks().filter(t => t.status === 'awaiting_approval');
}

export function findTaskByApprovalMessage(messageId) {
  return loadTasks().find(t =>
    t.status === 'awaiting_approval' && t.approval_message_id === messageId
  ) || null;
}

export function getTaskById(id) {
  return loadTasks().find(t => t.id === id) || null;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

export function canRunTask() {
  const tasks = loadTasks();
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // Check concurrent: no task currently running
  const running = tasks.find(t => t.status === 'running');
  if (running) return { allowed: false, reason: `task ${running.id} already running` };

  // Check daily limit
  const todayTasks = tasks.filter(t =>
    t.created.startsWith(today) && ['running', 'awaiting_approval', 'approved', 'deployed'].includes(t.status)
  );
  if (todayTasks.length >= MAX_TASKS_PER_DAY) {
    return { allowed: false, reason: `daily limit reached (${MAX_TASKS_PER_DAY})` };
  }

  // Check interval: last completed/failed task must be > 1hr ago
  const recent = tasks
    .filter(t => ['awaiting_approval', 'deployed', 'failed'].includes(t.status))
    .sort((a, b) => new Date(b.created) - new Date(a.created))[0];

  if (recent) {
    const elapsed = now - new Date(recent.created).getTime();
    if (elapsed < MIN_TASK_INTERVAL_MS) {
      const minsLeft = Math.ceil((MIN_TASK_INTERVAL_MS - elapsed) / 60000);
      return { allowed: false, reason: `cooldown: ${minsLeft}min remaining` };
    }
  }

  return { allowed: true, reason: null };
}

// ── Approval message formatting ─────────────────────────────────────────────

export function formatApprovalMessage(task) {
  let msg = `*EVOLUTION TASK — Awaiting Approval*\n`;
  msg += `Task: ${task.id}\n`;
  msg += `Source: ${task.source}\n`;
  msg += `Instruction: ${task.instruction}\n\n`;

  // Show manifest (scope plan) if available
  if (task.manifest) {
    const m = task.manifest;
    msg += `*Planned scope:* ${m.files_to_modify?.join(', ') || '?'}\n`;
    msg += `*Estimated lines:* ${m.estimated_lines_changed || '?'}`;
    if (task.total_lines) msg += ` (actual: ${task.total_lines})`;
    msg += `\n`;
    if (m.approach) msg += `*Approach:* ${m.approach}\n`;
    if (m.risks) msg += `*Risks:* ${m.risks}\n`;
    msg += `\n`;
  }

  if (task.diff_summary) {
    msg += `*Diff stat:*\n${task.diff_summary}\n\n`;
  }

  if (task.files_changed?.length) {
    msg += `*Files changed:* ${task.files_changed.join(', ')}\n\n`;
  }

  if (task.diff_detail) {
    // Truncate diff for WhatsApp readability
    const diffPreview = task.diff_detail.length > 2000
      ? task.diff_detail.slice(0, 2000) + '\n... (truncated)'
      : task.diff_detail;
    msg += `*Diff:*\n\`\`\`\n${diffPreview}\n\`\`\`\n\n`;
  }

  msg += `Reply *approve* to deploy or *reject* to discard.`;
  return msg;
}

// ── List tasks (for system_status or debugging) ─────────────────────────────

export function getTaskSummary() {
  const tasks = loadTasks();
  const today = new Date().toISOString().split('T')[0];
  const todayTasks = tasks.filter(t => t.created.startsWith(today));

  return {
    total: tasks.length,
    today: todayTasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    running: tasks.filter(t => t.status === 'running').length,
    awaiting: tasks.filter(t => t.status === 'awaiting_approval').length,
    deployed: todayTasks.filter(t => t.status === 'deployed').length,
    failed: todayTasks.filter(t => t.status === 'failed').length,
  };
}

// ── Detailed report for overnight summary ───────────────────────────────────

export function getEvolutionReport() {
  const tasks = loadTasks();
  const now = Date.now();
  const oneDayAgo = now - 86400000;
  const today = new Date().toISOString().split('T')[0];

  // Tasks that changed status in the last 24h (relevant for overnight report)
  const recentDeployed = tasks.filter(t =>
    t.status === 'deployed' && new Date(t.created).getTime() > oneDayAgo
  );
  const recentFailed = tasks.filter(t =>
    t.status === 'failed' && new Date(t.created).getTime() > oneDayAgo
  );
  const recentRejected = tasks.filter(t =>
    t.status === 'rejected' && new Date(t.created).getTime() > oneDayAgo
  );
  const awaiting = tasks.filter(t => t.status === 'awaiting_approval');
  const pending = tasks.filter(t => t.status === 'pending');
  const { allowed, reason } = canRunTask();

  const formatTask = (t) => ({
    id: t.id,
    source: t.source,
    instruction: t.instruction.slice(0, 120),
    files: t.files_changed || [],
    lines: t.total_lines || null,
    branch: t.branch,
    created: t.created,
    result: t.result ? String(t.result).slice(0, 200) : null,
  });

  return {
    deployed: recentDeployed.map(formatTask),
    failed: recentFailed.map(formatTask),
    rejected: recentRejected.map(formatTask),
    awaiting: awaiting.map(t => ({
      ...formatTask(t),
      waitingHours: Math.round((now - new Date(t.created).getTime()) / 3600000),
    })),
    pending: pending.map(formatTask),
    rateLimit: {
      allowed,
      reason,
      todayCount: tasks.filter(t =>
        t.created.startsWith(today) && ['running', 'awaiting_approval', 'approved', 'deployed'].includes(t.status)
      ).length,
      dailyMax: MAX_TASKS_PER_DAY,
    },
  };
}
