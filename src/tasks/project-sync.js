// Task: project knowledge sync (nightly)
// Pulls selected project docs from local path or git mirror and stores changed
// files in EVO memory as document/document_chunk entries.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { appendEvent } from '../overnight/events.js';
import { runtimePath } from '../overnight/paths.js';
import { isEvoOnline, storeDocument } from '../memory.js';
import { getProjectsSnapshot } from '../tools/projects.js';
import logger from '../logger.js';

const execFileAsync = promisify(execFile);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const PROJECT_MIRROR_ROOT = join(REPO_ROOT, 'data', 'runtime', 'project-repos');
const PROJECTS_DEFAULTS_FILE = join(REPO_ROOT, 'data', 'runtime-defaults', 'projects.json');
const STATE_FILE = runtimePath('project-sync-state.json');

const DEFAULT_SYNC_HOUR = 2;
const MAX_FILE_BYTES = 250_000;
const MAX_FILES_PER_PROJECT = 60;
const DEFAULT_INCLUDE_PATHS = ['README.md', 'plan.md', 'architecture.md', 'docs'];
const READABLE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.py', '.js', '.ts', '.tsx']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', '.venv', 'venv']);

let lastProjectSyncDate = null;

function loadSyncState() {
  try {
    if (!existsSync(STATE_FILE)) return { projects: {} };
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'project-sync: failed to read state file');
    return { projects: {} };
  }
}

function saveSyncState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn({ err: err.message }, 'project-sync: failed to write state file');
  }
}

function loadDefaultProjects() {
  try {
    if (!existsSync(PROJECTS_DEFAULTS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(PROJECTS_DEFAULTS_FILE, 'utf-8'));
    return parsed.projects || [];
  } catch (err) {
    logger.warn({ err: err.message }, 'project-sync: failed to read default projects');
    return [];
  }
}

function buildProjectList() {
  const runtimeProjects = getProjectsSnapshot();
  const defaultsById = new Map(loadDefaultProjects().map((p) => [p.id, p]));
  const merged = runtimeProjects.map((project) => ({
    ...(defaultsById.get(project.id) || {}),
    ...project,
  }));
  for (const [id, fallbackProject] of defaultsById.entries()) {
    if (!merged.some((p) => p.id === id)) merged.push(fallbackProject);
  }
  return merged;
}

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function summarizeText(text) {
  const firstParagraph = text.split(/\n\s*\n/).find((p) => p.trim().length > 0) || '';
  return firstParagraph.trim().slice(0, 450) || 'Project document sync snapshot.';
}

async function runGit(args, cwd = REPO_ROOT) {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 120_000 });
  return stdout.trim();
}

async function resolveProjectSource(project) {
  const syncConfig = project.sync || {};
  const localCandidates = [project.evoPath, project.localPath]
    .filter(Boolean)
    .map((p) => String(p).replace(/^~\//, `${process.env.HOME || process.env.USERPROFILE || ''}/`));
  for (const candidate of localCandidates) {
    const absolute = resolve(candidate);
    if (existsSync(absolute)) return { root: absolute, source: `local:${absolute}` };
  }

  const preferGit = syncConfig.source === 'git' || (syncConfig.preferGit !== false && !!project.gitRepo);
  if (preferGit && project.gitRepo) {
    const mirrorDir = join(PROJECT_MIRROR_ROOT, project.id);
    mkdirSync(PROJECT_MIRROR_ROOT, { recursive: true });
    try {
      if (!existsSync(mirrorDir)) {
        await runGit(['clone', '--depth', '1', project.gitRepo, mirrorDir]);
      } else {
        await runGit(['-C', mirrorDir, 'pull', '--ff-only']);
      }
      return { root: mirrorDir, source: `git:${project.gitRepo}` };
    } catch (err) {
      logger.warn({ projectId: project.id, err: err.message }, 'project-sync: git source failed, falling back to local path');
    }
  }
  return null;
}

function walkFiles(root, dir, out) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_PROJECT * 4) return;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkFiles(root, join(dir, entry.name), out);
      continue;
    }
    const fullPath = join(dir, entry.name);
    const ext = extname(entry.name).toLowerCase();
    if (!READABLE_EXTENSIONS.has(ext)) continue;
    out.push(relative(root, fullPath).replace(/\\/g, '/'));
  }
}

function collectFiles(root, includePaths) {
  const targets = Array.isArray(includePaths) && includePaths.length > 0 ? includePaths : DEFAULT_INCLUDE_PATHS;
  const collected = new Set();
  for (const rawPath of targets) {
    const targetPath = resolve(root, rawPath);
    if (!targetPath.startsWith(resolve(root)) || !existsSync(targetPath)) continue;
    const stats = statSync(targetPath);
    if (stats.isFile()) {
      collected.add(relative(root, targetPath).replace(/\\/g, '/'));
      continue;
    }
    if (!stats.isDirectory()) continue;
    const nested = [];
    walkFiles(root, targetPath, nested);
    for (const file of nested) collected.add(file);
  }
  return [...collected].slice(0, MAX_FILES_PER_PROJECT);
}

async function syncProject(project, state) {
  const source = await resolveProjectSource(project);
  if (!source) return { skipped: true, reason: 'no source path available', synced: 0, source: null };

  const files = collectFiles(source.root, project.sync?.includePaths);
  if (files.length === 0) return { skipped: true, reason: 'no matching files', synced: 0, source: source.source };

  const projectState = state.projects[project.id] || { files: {} };
  let synced = 0;
  for (const relPath of files) {
    const absolute = resolve(source.root, relPath);
    if (!existsSync(absolute)) continue;
    const fileStats = statSync(absolute);
    if (fileStats.size > MAX_FILE_BYTES) continue;
    const rawText = readFileSync(absolute, 'utf-8');
    const hash = hashText(rawText);
    if (projectState.files[relPath] === hash) continue;

    await storeDocument({
      fileName: `${project.id}/${relPath}`,
      rawText,
      summary: summarizeText(rawText),
      sender: 'project_sync',
      chatJid: `project:${project.id}`,
    });
    projectState.files[relPath] = hash;
    synced += 1;
  }

  state.projects[project.id] = {
    ...projectState,
    lastSyncedAt: new Date().toISOString(),
    lastSource: source.source,
  };
  return { skipped: false, synced, source: source.source, reason: synced > 0 ? 'updated files synced' : 'no file changes' };
}

/**
 * Nightly project knowledge sync.
 * Runs once daily at configured hour (default 2 AM London), and once on first boot.
 */
export async function checkProjectKnowledgeSync(todayStr, hours) {
  if (!isEvoOnline()) return;
  if (lastProjectSyncDate === todayStr) return;

  const state = loadSyncState();
  const hasAnyRun = Object.keys(state.projects || {}).length > 0;
  const shouldRunNow = !hasAnyRun || hours === DEFAULT_SYNC_HOUR;
  if (!shouldRunNow) return;

  const projects = buildProjectList().filter((project) => project?.sync?.enabled);
  if (projects.length === 0) return;

  lastProjectSyncDate = todayStr;
  let syncedCount = 0;
  let skippedCount = 0;
  let errorSummary = null;

  try {
    for (const project of projects) {
      const result = await syncProject(project, state);
      if (result.skipped) {
        skippedCount += 1;
      } else {
        syncedCount += result.synced;
      }
      logger.info({ projectId: project.id, ...result }, 'project-sync: project processed');
    }
    saveSyncState(state);
  } catch (err) {
    errorSummary = err.message;
    logger.error({ err: err.message }, 'project-sync: sync failed');
  }

  try {
    await appendEvent({
      stage: 'operations',
      phase: 'project-sync',
      inputs: projects.map((p) => p.gitRepo || p.evoPath || p.localPath || p.id),
      outputs: errorSummary ? [] : ['memory:document,document_chunk,document_index'],
      verdict: errorSummary ? 'failed' : 'ok',
      reason: errorSummary ?? `${syncedCount} files synced across ${projects.length} project(s), ${skippedCount} skipped`,
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    }, { date: todayStr });
  } catch (err) {
    logger.warn({ err: err.message }, 'project-sync: failed to write event');
  }
}

export function getLastProjectSyncDate() {
  return lastProjectSyncDate;
}
