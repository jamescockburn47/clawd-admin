// src/evolution-executor.js — Runs Claude Code CLI on EVO via SSH
//
// Orchestrates: git branch → Claude Code headless → capture diff → return results.
// Runs on Pi, SSHes to EVO where Claude Code CLI is installed.

import { execSync } from 'child_process';
import logger from './logger.js';

const EVO_HOST = '10.0.0.2';
const EVO_USER = 'james';
const EVO_REPO = '/home/james/clawdbot-claude-code';
const CLAUDE_BIN = '/home/james/.local/bin/claude';
const SSH_OPTS = '-o ConnectTimeout=10 -o StrictHostKeyChecking=no';
const MAX_RUNTIME_MS = 5 * 60 * 1000; // 5 min max for Claude Code

function ssh(cmd, timeoutMs = 30000) {
  return execSync(
    `ssh ${SSH_OPTS} ${EVO_USER}@${EVO_HOST} '${cmd.replace(/'/g, "'\\''")}'`,
    { encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe' }
  ).trim();
}

/**
 * Sync Pi's current codebase to EVO before running Claude Code.
 * This ensures EVO has the latest deployed code.
 */
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

/**
 * Execute a coding task via Claude Code CLI on EVO.
 *
 * Flow:
 * 1. Sync codebase Pi → EVO
 * 2. Create git branch on EVO
 * 3. Run Claude Code headless with the instruction
 * 4. Capture git diff
 * 5. Return results
 */
export async function executeEvolutionTask(task) {
  const { id, instruction, branch } = task;

  logger.info({ taskId: id, branch }, 'evolution: starting execution');

  // 1. Sync Pi codebase to EVO
  syncToEvo();

  // 2. Ensure git repo is clean and create branch
  try {
    ssh(`cd ${EVO_REPO} && git checkout main 2>/dev/null; git checkout -b ${branch} 2>/dev/null || git checkout ${branch}`);
    logger.info({ branch }, 'evolution: branch ready');
  } catch (err) {
    throw new Error(`Git branch setup failed: ${err.message}`);
  }

  // 3. Run Claude Code CLI headless
  let claudeOutput;
  try {
    // Build the prompt with context
    const prompt = [
      `You are modifying the Clawdbot codebase. Read CLAUDE.md first for full context.`,
      `Task: ${instruction}`,
      `Rules:`,
      `- Make minimal, focused changes`,
      `- Do not modify CLAUDE.md`,
      `- Do not touch data/ files`,
      `- Test your changes make sense by reading surrounding code`,
      `- Commit your changes with a clear message`,
    ].join('\n');

    // Escape for shell
    const escapedPrompt = prompt.replace(/'/g, "'\\''").replace(/\n/g, '\\n');

    claudeOutput = ssh(
      `cd ${EVO_REPO} && export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2- | tr -d '"' | tr -d "'") && ${CLAUDE_BIN} -p '${escapedPrompt}' --dangerously-skip-permissions --output-format json 2>&1 || true`,
      MAX_RUNTIME_MS
    );

    logger.info({ taskId: id, outputLen: claudeOutput.length }, 'evolution: Claude Code completed');
  } catch (err) {
    // Clean up branch on failure
    try { ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch}`); } catch {}
    throw new Error(`Claude Code execution failed: ${err.message}`);
  }

  // 4. Get the diff and changed files
  let diff, filesChanged, summary;
  try {
    diff = ssh(`cd ${EVO_REPO} && git diff main --stat && echo '---FULL---' && git diff main`, 60000);
    filesChanged = ssh(`cd ${EVO_REPO} && git diff main --name-only`)
      .split('\n')
      .filter(f => f.trim());

    // Generate summary from diff stat
    const statLines = diff.split('---FULL---')[0].trim();
    summary = statLines || 'No changes detected';
    diff = diff.split('---FULL---')[1]?.trim() || '';

  } catch (err) {
    logger.warn({ err: err.message }, 'evolution: diff extraction failed');
    diff = '';
    filesChanged = [];
    summary = 'Could not extract diff';
  }

  if (!filesChanged.length) {
    // No changes — clean up
    try { ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch}`); } catch {}
    throw new Error('Claude Code ran but produced no file changes');
  }

  return {
    branch,
    diff,
    summary,
    files: filesChanged,
    claudeOutput: claudeOutput.slice(0, 5000), // truncate for logging
  };
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
  } catch {}

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
