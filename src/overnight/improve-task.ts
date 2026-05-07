// src/overnight/improve-task.ts — scheduler-invoked IMPROVE task.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.4.
//
// Fires Saturday 22:00 London (start of Saturday-night overnight window).
// Also accepts on-demand emergency trigger via direct call with
// emergencyMode: true (see http-server /api/forge-now route).
//
// Wires real clients: EVO for synthesis, Claude Code CLI for Opus + implement,
// evoSimpleChat for replay + grader, execFile-based deploy client that uses
// scripts/forge-ci.sh for branch-first CI. All deps lazy-imported to avoid
// triggering config validation during test mode.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { OvernightRunner } from './runner.js';
import { makeImproveStage, type ImproveStageDeps } from './improve.js';
import type { EvoChatClient } from './probe-patterns.js';
import type { OpusClient } from './improve-opus-select.js';
import type { ClaudeCliClient } from './improve-implement.js';
import type { ReplayPairClient, StratifiedGrader } from './improve-replay.js';
import type { DeployClient } from './improve-deploy.js';

const execAsync = promisify(exec);

export const IMPROVE_TASK_HOUR = 22;
export const IMPROVE_TASK_MINUTE = 0;
export const IMPROVE_TASK_DAY_OF_WEEK = 6; // Saturday

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIR, '..', '..');
const DEFAULT_OVERNIGHT_DIR = join(DEFAULT_REPO_ROOT, 'data', 'overnight');
const DEFAULT_LOG_DIR = join(DEFAULT_REPO_ROOT, 'data', 'conversation-logs');
const FORGE_CI_SCRIPT = join(DEFAULT_REPO_ROOT, 'scripts', 'forge-ci.sh');
const CLAUDE_CLI_BIN = '~/.local/bin/claude';

let lastImproveDate: string | null = null;

export function resetImproveTaskStateForTests(): void {
  lastImproveDate = null;
}

async function buildDefaultDeps(): Promise<ImproveStageDeps> {
  const { evoSimpleChat } = await import('../evo-llm.js');
  const { TIMEOUTS } = await import('../constants.js');

  const evoChatClient: EvoChatClient = {
    chat: async (sys, user) => {
      const r = await evoSimpleChat(sys, user, 2000, TIMEOUTS.MEMORY_EXTRACT);
      return typeof r === 'string' ? r : null;
    },
  };

  // Opus client: calls Claude Code CLI in print mode with --model claude-opus-4-6
  // and no tool allowance (selection doesn't need tools). Uses the Max subscription
  // credentials (ANTHROPIC_API_KEY unset to force OAuth).
  const opusClient: OpusClient = {
    callOpus: async (systemPrompt, userMessage) => {
      const promptFile = join(tmpdir(), `improve-opus-prompt-${process.pid}.md`);
      try {
        await writeFile(promptFile, `${systemPrompt}\n\n---\n\n${userMessage}`, 'utf8');
        const cmd = `env -u ANTHROPIC_API_KEY ${CLAUDE_CLI_BIN} -p --model claude-opus-4-6 < "${promptFile}"`;
        const { stdout } = await execAsync(cmd, {
          cwd: DEFAULT_REPO_ROOT,
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout || null;
      } catch {
        return null;
      } finally {
        try {
          await unlink(promptFile);
        } catch {
          // intentional: best-effort cleanup
        }
      }
    },
  };

  // Claude Code CLI client for the implement phase. Runs inside a given
  // worktree directory with the usual allowed tools.
  const claudeCliClient: ClaudeCliClient = {
    runSession: async ({ worktreeDir, prompt }) => {
      const promptFile = join(tmpdir(), `improve-implement-prompt-${process.pid}.md`);
      try {
        await writeFile(promptFile, prompt, 'utf8');
        const cmd =
          `env -u ANTHROPIC_API_KEY ${CLAUDE_CLI_BIN} -p ` +
          `--model claude-opus-4-6 ` +
          `--allowedTools "Edit,Write,Read,Bash,Glob,Grep" ` +
          `< "${promptFile}"`;
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd: worktreeDir,
            maxBuffer: 50 * 1024 * 1024,
          });
          return { stdout, stderr, exitCode: 0 };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number };
          return {
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? (err as Error).message,
            exitCode: typeof e.code === 'number' ? e.code : 1,
          };
        }
      } finally {
        try {
          await unlink(promptFile);
        } catch {
          // intentional: best-effort cleanup
        }
      }
    },
  };

  // Replay pair client: for now both main and worktree go through
  // evoSimpleChat with a "respond as Clint" system prompt. A stricter
  // replay calling getClawdResponse is a follow-up improvement.
  const replaySystemPrompt =
    'You are Clint, a WhatsApp assistant for James (a senior commercial litigation solicitor). ' +
    'Respond naturally in plain English, under 200 words. No emojis. No markdown headings.';
  const replayPairClient: ReplayPairClient = {
    replayAgainstMain: async (userInput) => await evoSimpleChat(replaySystemPrompt, userInput, 400),
    replayAgainstWorktree: async (userInput) => {
      // After the worktree has been merged or is pending merge, we can't
      // easily invoke "the other bot". For Phase 4 the worktree runs the
      // same EVO model (we're not swapping models, just code), so replay
      // against the same EVO gives us a code-change-specific comparison
      // once the worktree is live. Until proper worktree-scoped replay is
      // built, this produces the same result as main — effectively a
      // neutral/no-op. A dedicated cortex-level replay is future work.
      return await evoSimpleChat(replaySystemPrompt, userInput, 400);
    },
  };

  const replayGrader: StratifiedGrader = {
    grade: async (original, newResponse, userInput) => {
      const sys = `You are judging whether a WhatsApp bot's response has drifted
or changed meaningfully. Compare Response A (baseline) and Response B (new).
Output STRICT JSON: {"judged":"better"|"worse"|"neutral","reason":"one sentence"}.
Base judgment on accuracy, relevance, memory citation, and James's terse style.
Return ONLY the JSON object.`;
      const user = `User input:\n${userInput}\n\nResponse A:\n${original}\n\nResponse B:\n${newResponse}`;
      const raw = await evoSimpleChat(sys, user, 200);
      if (!raw) return { judged: 'neutral', reason: 'grader unavailable' };
      try {
        const text = raw.trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1) {
          return { judged: 'neutral', reason: 'grader returned non-JSON' };
        }
        const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
        const judged =
          parsed.judged === 'better' || parsed.judged === 'worse' ? parsed.judged : 'neutral';
        const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
        return { judged, reason };
      } catch {
        return { judged: 'neutral', reason: 'grader parse failed' };
      }
    },
  };

  // Deploy client: pushes via git push, runs scripts/forge-ci.sh, merges
  // via git merge --ff-only or --no-ff depending on CI. Proposal opens
  // a DM to the owner via the existing sendMessage path (injected elsewhere
  // in the running bot; for the scheduler task path we use sockRef).
  const deployClient: DeployClient = {
    pushBranch: async (branchName, worktreeDir) => {
      await execAsync(`git push -u origin ${branchName}`, { cwd: worktreeDir, maxBuffer: 10 * 1024 * 1024 });
      return branchName;
    },
    runCi: async (branchRef) => {
      try {
        const { stdout } = await execAsync(`bash "${FORGE_CI_SCRIPT}" "${branchRef}"`, {
          cwd: DEFAULT_REPO_ROOT,
          maxBuffer: 50 * 1024 * 1024,
        });
        return { ok: true, output: stdout };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, output: (e.stdout ?? '') + '\n' + (e.stderr ?? e.message ?? '') };
      }
    },
    mergeBranch: async (branchRef) => {
      await execAsync(`git checkout main && git merge --ff-only ${branchRef}`, {
        cwd: DEFAULT_REPO_ROOT,
        maxBuffer: 10 * 1024 * 1024,
      });
    },
    openProposal: async (payload) => {
      // Write the proposal to data/overnight/proposals/ for the morning
      // report to surface. A DM hook will be wired by the bot's main loop.
      const proposalsDir = join(DEFAULT_OVERNIGHT_DIR, 'proposals');
      const { mkdir, writeFile: wf } = await import('node:fs/promises');
      await mkdir(proposalsDir, { recursive: true });
      const filename = `proposal-${Date.now()}-${payload.candidate.id}.json`;
      await wf(
        join(proposalsDir, filename),
        JSON.stringify(payload, null, 2),
        'utf8',
      );
    },
  };

  return {
    overnightDir: DEFAULT_OVERNIGHT_DIR,
    logDir: DEFAULT_LOG_DIR,
    repoRoot: DEFAULT_REPO_ROOT,
    evoChatClient,
    opusClient,
    claudeCliClient,
    replayPairClient,
    replayGrader,
    deployClient,
  };
}

/**
 * Scheduler-invoked IMPROVE task. Fires Saturday 22:00 London.
 */
export async function checkImprove(
  todayStr: string,
  hours: number,
  minutes: number,
  deps?: ImproveStageDeps,
  options?: { emergencyMode?: boolean },
): Promise<void> {
  const isEmergency = options?.emergencyMode === true;

  if (!isEmergency) {
    // Scheduled mode: Saturday 22:00 only
    const date = new Date(todayStr + 'T12:00:00Z');
    if (date.getUTCDay() !== IMPROVE_TASK_DAY_OF_WEEK) return;
    if (hours !== IMPROVE_TASK_HOUR || minutes !== IMPROVE_TASK_MINUTE) return;
    if (lastImproveDate === todayStr) return;
    lastImproveDate = todayStr;
  }

  const resolvedDeps = deps ?? (await buildDefaultDeps());
  const stage = makeImproveStage(resolvedDeps, { emergencyMode: isEmergency });

  const runner = new OvernightRunner({
    mode: isEmergency ? 'emergency' : 'deep',
    date: todayStr,
    overnightDir: resolvedDeps.overnightDir,
    repoRoot: resolvedDeps.repoRoot,
    skipJanitor: false, // sweep stale worktrees before creating a new one
  });
  runner.register('improve', stage);
  await runner.run(['improve']);
}

// Keep the readFile import used for proposal reading in the future.
void readFile;
