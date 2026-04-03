// Audit logging — append-only log of tool executions for accountability
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const AUDIT_FILE = join(DATA_DIR, 'audit.json');

const MAX_ENTRIES = 1000;
let auditLog = [];
let loaded = false;
let saveTimer = null;

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    if (existsSync(AUDIT_FILE)) {
      const data = await readFile(AUDIT_FILE, 'utf-8');
      auditLog = JSON.parse(data);
    }
  } catch {
    auditLog = [];
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(AUDIT_FILE, JSON.stringify(auditLog, null, 2));
    } catch (err) {
      logger.error({ err: err.message }, 'audit save failed');
    }
  }, 2000);
}

export async function logAudit(entry) {
  await ensureLoaded();
  auditLog.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (auditLog.length > MAX_ENTRIES) {
    auditLog = auditLog.slice(-MAX_ENTRIES);
  }
  scheduleSave();
}

export async function getAuditLog(limit = 50) {
  await ensureLoaded();
  return auditLog.slice(-limit);
}

export async function flushAudit() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (auditLog.length > 0) {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(AUDIT_FILE, JSON.stringify(auditLog, null, 2));
    } catch { /* intentional: best-effort audit flush on shutdown */ }
  }
}

// Load on import
ensureLoaded();
