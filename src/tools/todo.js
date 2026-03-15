// Todo / reminders system — in-memory with debounced async persistence
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(__dirname, '..', '..', 'data');
const TODO_FILE = join(DATA_DIR, 'todos.json');

// --- In-memory store with debounced persistence ---
let todos = [];
let loaded = false;
let saveTimer = null;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    if (existsSync(TODO_FILE)) {
      const data = await readFile(TODO_FILE, 'utf-8');
      todos = JSON.parse(data);
    }
  } catch {
    todos = [];
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(TODO_FILE, JSON.stringify(todos, null, 2));
    } catch (err) {
      logger.error({ err: err.message }, 'todo save failed');
    }
  }, 500);
}

export async function flushTodos() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(TODO_FILE, JSON.stringify(todos, null, 2));
  } catch (err) {
    logger.error({ err: err.message }, 'todo flush failed');
  }
}

function nextId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Tool handlers ---

export async function todoAdd({ text, due_date, reminder, priority }) {
  await ensureLoaded();
  const item = {
    id: nextId(),
    text,
    done: false,
    priority: priority || 'normal',
    createdAt: new Date().toISOString(),
    completedAt: null,
    dueDate: due_date || null,
    reminder: reminder || null,
    reminded: false,
  };
  todos.push(item);
  scheduleSave();
  let result = `Added: "${text}" (id: ${item.id})`;
  if (due_date) result += `\nDue: ${due_date}`;
  if (reminder) result += `\nReminder: ${reminder}`;
  return result;
}

export async function todoList({ show_done, priority }) {
  await ensureLoaded();
  let filtered = show_done ? todos : todos.filter((t) => !t.done);
  if (priority) filtered = filtered.filter((t) => t.priority === priority);

  if (filtered.length === 0) return show_done ? 'No todos found.' : 'No active todos. All clear!';

  const priorityOrder = { high: 0, normal: 1, low: 2 };
  filtered.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const pa = priorityOrder[a.priority] ?? 1;
    const pb = priorityOrder[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  return filtered.map((t) => {
    const status = t.done ? '✓' : '○';
    const pFlag = t.priority === 'high' ? ' ‼️' : t.priority === 'low' ? ' ↓' : '';
    const due = t.dueDate ? ` (due: ${t.dueDate})` : '';
    const rem = t.reminder && !t.reminded ? ` [reminder: ${t.reminder}]` : '';
    return `${status} ${t.text}${pFlag}${due}${rem}\n  id: ${t.id}`;
  }).join('\n\n');
}

export async function todoComplete({ id }) {
  await ensureLoaded();
  const item = todos.find((t) => t.id === id);
  if (!item) return `Todo not found: ${id}`;
  if (item.done) return `Already completed: "${item.text}"`;
  item.done = true;
  item.completedAt = new Date().toISOString();
  scheduleSave();
  return `Completed: "${item.text}"`;
}

export async function todoRemove({ id }) {
  await ensureLoaded();
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return `Todo not found: ${id}`;
  const removed = todos.splice(idx, 1)[0];
  scheduleSave();
  return `Removed: "${removed.text}"`;
}

export async function todoUpdate({ id, text, due_date, reminder, priority }) {
  await ensureLoaded();
  const item = todos.find((t) => t.id === id);
  if (!item) return `Todo not found: ${id}`;
  if (text !== undefined) item.text = text;
  if (due_date !== undefined) item.dueDate = due_date;
  if (reminder !== undefined) { item.reminder = reminder; item.reminded = false; }
  if (priority !== undefined) item.priority = priority;
  scheduleSave();
  return `Updated: "${item.text}"${item.dueDate ? ' (due: ' + item.dueDate + ')' : ''}${item.reminder ? ' [reminder: ' + item.reminder + ']' : ''}`;
}

// --- API for dashboard and scheduler ---

export function getAllTodos() {
  return todos;
}

export function getActiveTodos() {
  return todos.filter((t) => !t.done);
}

export function getDueReminders() {
  const now = new Date();
  return todos.filter((t) =>
    !t.done && t.reminder && !t.reminded && new Date(t.reminder) <= now
  );
}

export function markReminded(id) {
  const item = todos.find((t) => t.id === id);
  if (item) {
    item.reminded = true;
    scheduleSave();
  }
}

// Ensure loaded on import (non-blocking)
ensureLoaded();
