// src/evolution-executor.js — Runs Claude Code CLI on EVO via SSH
//
// Two-pass execution:
//   Pass 1 (PLAN): Claude Code outputs a JSON manifest (files, lines, approach, risks).
//   Validate: check manifest against file/line limits and banned paths.
//   Pass 2 (EXECUTE): Claude Code implements within approved scope.
//   Post-validate: check actual diff against manifest. Auto-reject violations.
//
// Runs on Pi, SSHes to EVO where Claude Code CLI is installed.

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import logger from './logger.js';
import { TIMEOUTS, LIMITS } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVO_HOST = config.evoSshHost;
const EVO_USER = config.evoSshUser;
const EVO_REPO = config.evoRepoPath;
const CLAUDE_BIN = '/home/james/.local/bin/claude';
const SSH_OPTS = '-o ConnectTimeout=10 -o StrictHostKeyChecking=no';

const PLAN_TIMEOUT_MS = TIMEOUTS.PLAN_PASS;
const EXECUTE_TIMEOUT_MS = TIMEOUTS.EXECUTE_PASS;
const PLAN_MAX_TURNS = LIMITS.PLAN_MAX_TURNS;
const EXECUTE_MAX_TURNS = LIMITS.EXECUTE_MAX_TURNS;

// --- Scope constraints ---
const MAX_FILES = LIMITS.EVOLUTION_MAX_FILES;
const MAX_LINES = LIMITS.EVOLUTION_MAX_LINES;
const ALLOWED_PREFIXES = ['src/', 'eval/'];

const BANNED_FILES = new Set([
  'CLAUDE.md',
  'EVOLUTION.md',
  '.env',
  'package.json',
  'package-lock.json',
]);

const BANNED_DIRS = [
  'data/',
  'auth_state/',
  '.claude/',
  'evo-hooks/',
  'evo-evolve/',
  'node_modules/',
  'docs/',
];

// --- SSH helpers ---

function ssh(cmd, timeoutMs = 30000) {
  return execSync(
    `ssh ${SSH_OPTS} ${EVO_USER}@${EVO_HOST} '${cmd.replace(/'/g, "'\\''")}'`,
    { encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe' }
  ).trim();
}

function sshWrite(remotePath, content, timeoutMs = 15000) {
  // Write content to a remote file via stdin to avoid shell escaping issues
  execSync(
    `ssh ${SSH_OPTS} ${EVO_USER}@${EVO_HOST} 'cat > ${remotePath}'`,
    { input: content, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

// --- Validation helpers ---

function isBanned(filePath) {
  if (BANNED_FILES.has(filePath)) return true;
  for (const dir of BANNED_DIRS) {
    if (filePath.startsWith(dir)) return true;
  }
  return false;
}

function isAllowedPath(filePath) {
  for (const prefix of ALLOWED_PREFIXES) {
    if (filePath.startsWith(prefix)) return true;
  }
  return false;
}

function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest is not a valid object'] };
  }

  const files = manifest.files_to_modify;
  if (!Array.isArray(files) || files.length === 0) {
    return { valid: false, errors: ['files_to_modify must be a non-empty array'] };
  }

  if (files.length > MAX_FILES) {
    errors.push(`Too many files: ${files.length} (max ${MAX_FILES})`);
  }

  const estimatedLines = manifest.estimated_lines_changed;
  if (typeof estimatedLines !== 'number' || estimatedLines > MAX_LINES) {
    errors.push(`Too many lines: ${estimatedLines} (max ${MAX_LINES})`);
  }

  for (const f of files) {
    if (isBanned(f)) {
      errors.push(`Banned file: ${f}`);
    }
    if (!isAllowedPath(f)) {
      errors.push(`File outside allowed paths (${ALLOWED_PREFIXES.join(', ')}): ${f}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function postValidateDiff(actualFiles, actualLines, manifest) {
  const errors = [];
  const allowed = new Set(manifest.files_to_modify);

  for (const f of actualFiles) {
    if (!allowed.has(f)) {
      errors.push(`Out-of-scope file modified: ${f}`);
    }
    if (isBanned(f)) {
      errors.push(`Banned file modified: ${f}`);
    }
  }

  if (actualLines > MAX_LINES) {
    errors.push(`Too many lines changed: ${actualLines} (max ${MAX_LINES})`);
  }

  return { valid: errors.length === 0, errors };
}

// --- JSON extraction ---

function extractJsonFromOutput(text) {
  // Claude Code may wrap JSON in markdown code blocks or add preamble
  // Try raw parse first
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Try extracting from ```json ... ``` or ``` ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch { /* continue */ }
  }

  // Try finding the first { ... } block
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(text.slice(braceStart, braceEnd + 1));
    } catch { /* continue */ }
  }

  return null;
}

// --- Codebase sync ---

function syncToEvo() {
  try {
    execSync(
      `rsync -az --timeout=30 --exclude node_modules --exclude .baileys --exclude 'data/conversation-logs' /home/pi/clawdbot/ ${EVO_USER}@${EVO_HOST}:${EVO_REPO}/`,
      { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' }
    );
    logger.info('evolution: synced Pi → EVO');
  } catch (err) {
    logger.warn({ err: err.message }, 'evolution: rsync to EVO failed, using existing EVO code');
  }
}

// --- Branch management ---

function setupBranch(branch) {
  ssh(`cd ${EVO_REPO} && git checkout main 2>/dev/null; git checkout -b ${branch} 2>/dev/null || git checkout ${branch}`);
  logger.info({ branch }, 'evolution: branch ready');
}

function cleanupBranch(branch) {
  try {
    ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch} 2>/dev/null || true`);
  } catch { /* best effort */ }
}

function cleanupScopeFiles() {
  try {
    ssh(`rm -f ${EVO_REPO}/.evolution-scope.md /tmp/evo-task-scope.json`);
  } catch { /* best effort */ }
}

// --- Claude Code invocation ---

function getApiEnvCmd() {
  // Use MiniMax M2.7 for evolution tasks (cheap, near-Opus coding quality)
  // Falls back to Claude API key from bashrc if MINIMAX vars not set
  return [
    `export MINIMAX_KEY=$(grep MINIMAX_API_KEY ~/.bashrc | cut -d= -f2- | tr -d '"' | tr -d "'" 2>/dev/null)`,
    `if [ -n "$MINIMAX_KEY" ]; then`,
    `  export ANTHROPIC_API_KEY="$MINIMAX_KEY"`,
    `  export ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic"`,
    `  export ANTHROPIC_MODEL="MiniMax-M2.7"`,
    `else`,
    `  export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2- | tr -d '"' | tr -d "'")`,
    `fi`,
    `export CLAUDE_CODE_ATTRIBUTION_HEADER=0`,
  ].join(' && ');
}

function runClaudeCode(prompt, { timeoutMs, maxTurns, outputFormat = 'text' }) {
  const escapedPrompt = prompt.replace(/'/g, "'\\''").replace(/\n/g, '\\n');
  const output = ssh(
    `cd ${EVO_REPO} && ${getApiEnvCmd()} && ${CLAUDE_BIN} -p '${escapedPrompt}' --dangerously-skip-permissions --output-format ${outputFormat} --max-turns ${maxTurns} 2>&1 || true`,
    timeoutMs
  );
  return output;
}

// --- EVOLUTION.md template ---

function loadEvolutionTemplate() {
  const templatePath = join(__dirname, '..', 'EVOLUTION.md');
  return readFileSync(templatePath, 'utf-8');
}

function buildScopeDoc(allowedFiles, instruction) {
  const template = loadEvolutionTemplate();
  const fileList = allowedFiles.map(f => `- ${f}`).join('\n');
  return template
    .replace('{{ALLOWED_FILES}}', fileList)
    .replace('{{TASK_INSTRUCTION}}', instruction);
}

// --- Main execution ---

/**
 * Execute a coding task via Claude Code CLI on EVO.
 *
 * Two-pass flow:
 * 1. Sync codebase Pi → EVO
 * 2. Create git branch on EVO
 * 3. Pass 1 (PLAN): Claude Code outputs JSON manifest — no code changes
 * 4. Validate manifest against limits
 * 5. Write scope files to EVO
 * 6. Pass 2 (EXECUTE): Claude Code implements within scope
 * 7. Post-validate: check actual diff against manifest
 * 8. Return results for human approval
 */
export async function executeEvolutionTask(task) {
  const { id, instruction, branch } = task;

  logger.info({ taskId: id, branch }, 'evolution: starting two-pass execution');

  // 1. Sync Pi codebase to EVO
  syncToEvo();

  // 2. Create branch
  try {
    setupBranch(branch);
  } catch (err) {
    throw new Error(`Git branch setup failed: ${err.message}`);
  }

  let manifest = null;

  try {
    // ----------------------------------------------------------------
    // PASS 1: PLANNING — get a JSON manifest, no code changes
    // ----------------------------------------------------------------
    logger.info({ taskId: id }, 'evolution: pass 1 (plan)');

    const planPrompt = [
      'You are analysing the Clawdbot codebase to plan a code change.',
      'Read the relevant source files, then output ONLY a JSON object with this exact schema:',
      '',
      '{',
      '  "files_to_modify": ["src/example.js"],',
      '  "estimated_lines_changed": 42,',
      '  "approach": "Brief description of what you will change and how",',
      '  "risks": "Any risks or edge cases"',
      '}',
      '',
      'Rules:',
      `- ONLY files under ${ALLOWED_PREFIXES.join(' or ')} are allowed`,
      `- Maximum ${MAX_FILES} files`,
      `- Maximum ${MAX_LINES} lines changed`,
      '- Do NOT modify any files. Do NOT write any code. Output ONLY the JSON.',
      '- Do NOT modify CLAUDE.md, EVOLUTION.md, .env, package.json, or anything in data/, auth_state/, .claude/, node_modules/, docs/',
      '',
      `Task: ${instruction}`,
    ].join('\n');

    const planOutput = runClaudeCode(planPrompt, {
      timeoutMs: PLAN_TIMEOUT_MS,
      maxTurns: PLAN_MAX_TURNS,
      outputFormat: 'text',
    });

    logger.debug({ taskId: id, planOutputLen: planOutput.length }, 'evolution: plan output received');

    // Extract JSON manifest from output
    manifest = extractJsonFromOutput(planOutput);

    if (!manifest) {
      throw new Error(`Plan pass did not produce valid JSON. Output (first 1000 chars): ${planOutput.slice(0, 1000)}`);
    }

    logger.info({ taskId: id, manifest }, 'evolution: manifest extracted');

    // ----------------------------------------------------------------
    // VALIDATE MANIFEST
    // ----------------------------------------------------------------
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
    }

    logger.info({ taskId: id, files: manifest.files_to_modify }, 'evolution: manifest validated');

    // Discard any uncommitted changes from planning pass (should be none, but belt and suspenders)
    ssh(`cd ${EVO_REPO} && git checkout -- . && git clean -fd`, 15000);

    // ----------------------------------------------------------------
    // WRITE SCOPE FILES TO EVO
    // ----------------------------------------------------------------

    // Write .evolution-scope.md (filled-in EVOLUTION.md template)
    const scopeDoc = buildScopeDoc(manifest.files_to_modify, instruction);
    sshWrite(`${EVO_REPO}/.evolution-scope.md`, scopeDoc);

    // Write /tmp/evo-task-scope.json for PreToolUse hook enforcement
    const scopeJson = JSON.stringify({ allowed_files: manifest.files_to_modify });
    sshWrite('/tmp/evo-task-scope.json', scopeJson);

    logger.info({ taskId: id }, 'evolution: scope files written to EVO');

    // ----------------------------------------------------------------
    // PASS 2: EXECUTE — implement within scope
    // ----------------------------------------------------------------
    logger.info({ taskId: id }, 'evolution: pass 2 (execute)');

    const executePrompt = [
      'Read .evolution-scope.md in the repo root for your task instructions and allowed file scope.',
      'Follow ALL rules in that file. Only modify the files listed in the SCOPE section.',
      'Commit your changes with a clear message when done.',
    ].join('\n');

    const executeOutput = runClaudeCode(executePrompt, {
      timeoutMs: EXECUTE_TIMEOUT_MS,
      maxTurns: EXECUTE_MAX_TURNS,
      outputFormat: 'json',
    });

    logger.info({ taskId: id, executeOutputLen: executeOutput.length }, 'evolution: execute pass completed');

    // ----------------------------------------------------------------
    // POST-VALIDATION: check actual diff against manifest
    // ----------------------------------------------------------------
    const filesChanged = ssh(`cd ${EVO_REPO} && git diff main --name-only`)
      .split('\n')
      .filter(f => f.trim());

    if (!filesChanged.length) {
      throw new Error('Claude Code ran but produced no file changes');
    }

    // Count actual lines changed (additions + deletions)
    const diffStat = ssh(`cd ${EVO_REPO} && git diff main --shortstat`, 15000);
    // Format: " 2 files changed, 45 insertions(+), 12 deletions(-)"
    const insertions = parseInt((diffStat.match(/(\d+) insertion/) || [0, 0])[1], 10);
    const deletions = parseInt((diffStat.match(/(\d+) deletion/) || [0, 0])[1], 10);
    const totalLines = insertions + deletions;

    logger.info({ taskId: id, filesChanged, totalLines }, 'evolution: post-validation check');

    const postCheck = postValidateDiff(filesChanged, totalLines, manifest);
    if (!postCheck.valid) {
      throw new Error(`Post-validation failed: ${postCheck.errors.join('; ')}`);
    }

    logger.info({ taskId: id }, 'evolution: post-validation passed');

    // ----------------------------------------------------------------
    // COLLECT RESULTS
    // ----------------------------------------------------------------
    const diff = ssh(`cd ${EVO_REPO} && git diff main --stat && echo '---FULL---' && git diff main`, 60000);
    const statLines = diff.split('---FULL---')[0].trim();
    const fullDiff = diff.split('---FULL---')[1]?.trim() || '';
    const summary = statLines || 'No summary available';

    // Clean up scope files (not the branch — that's needed for approval)
    cleanupScopeFiles();

    return {
      branch,
      diff: fullDiff,
      summary,
      files: filesChanged,
      totalLines,
      manifest,
      claudeOutput: executeOutput.slice(0, 5000),
    };

  } catch (err) {
    // Clean up on any failure
    cleanupScopeFiles();
    cleanupBranch(branch);
    throw err;
  }
}

/**
 * Deploy approved changes from EVO branch to Pi.
 *
 * Flow:
 * 1. Merge branch to main on EVO
 * 2. Rsync changed files back to Pi
 * 3. Restart clawdbot service
 * 4. Health check
 */
export async function deployApprovedTask(task) {
  const { id, branch, files_changed } = task;

  logger.info({ taskId: id, branch, files: files_changed }, 'evolution: deploying');

  // 1. Merge branch to main on EVO
  try {
    ssh(`cd ${EVO_REPO} && git checkout main && git merge ${branch} --no-edit`);
    logger.info({ branch }, 'evolution: merged to main');
  } catch (err) {
    throw new Error(`Merge failed: ${err.message}`);
  }

  // 2. Rsync changed files back to Pi
  try {
    for (const file of files_changed) {
      // Only sync src/ files — never data/, node_modules, etc.
      if (!file.startsWith('src/') && !file.startsWith('eval/')) continue;
      execSync(
        `rsync -az ${EVO_USER}@${EVO_HOST}:${EVO_REPO}/${file} /home/pi/clawdbot/${file}`,
        { encoding: 'utf-8', timeout: 15000, stdio: 'pipe' }
      );
    }
    logger.info({ files: files_changed.length }, 'evolution: files synced to Pi');
  } catch (err) {
    throw new Error(`File sync failed: ${err.message}`);
  }

  // 3. Restart clawdbot
  try {
    execSync('sudo systemctl restart clawdbot', { timeout: 15000, stdio: 'pipe' });
    logger.info('evolution: service restarted');
  } catch (err) {
    throw new Error(`Service restart failed: ${err.message}`);
  }

  // 4. Health check — wait 5s, verify service is active
  await new Promise(resolve => setTimeout(resolve, 5000));
  try {
    const status = execSync('systemctl is-active clawdbot', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (status !== 'active') {
      throw new Error(`Service not active after restart: ${status}`);
    }
    logger.info('evolution: health check passed');
  } catch (err) {
    // Rollback: restore from pre-deploy backup
    logger.error({ err: err.message }, 'evolution: HEALTH CHECK FAILED — rolling back');
    try {
      ssh(`cd ${EVO_REPO} && git revert HEAD --no-edit`);
      execSync(
        `rsync -az ${EVO_USER}@${EVO_HOST}:${EVO_REPO}/src/ /home/pi/clawdbot/src/`,
        { encoding: 'utf-8', timeout: 30000, stdio: 'pipe' }
      );
      execSync('sudo systemctl restart clawdbot', { timeout: 15000, stdio: 'pipe' });
    } catch (rbErr) {
      logger.error({ err: rbErr.message }, 'evolution: ROLLBACK ALSO FAILED');
    }
    throw new Error(`Deploy failed health check: ${err.message}. Rolled back.`);
  }

  // Clean up branch
  try {
    ssh(`cd ${EVO_REPO} && git branch -D ${branch}`);
  } catch { /* intentional: branch cleanup is best-effort */ }

  return { success: true, files: files_changed };
}

/**
 * Reject a task — clean up the branch on EVO.
 */
export async function rejectTask(task) {
  const { branch } = task;
  try {
    ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch} 2>/dev/null || true`);
    logger.info({ branch }, 'evolution: branch deleted (rejected)');
  } catch {
    // Branch may not exist — that's fine
  }
}
