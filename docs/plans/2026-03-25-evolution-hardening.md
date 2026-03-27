# Evolution Pipeline Hardening

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent Claude Code from touching files outside the task scope during self-coding sessions.

**Architecture:** Three-layer defence: (1) scoped prompt with explicit file allowlist, (2) PreToolUse hook on EVO that hard-blocks edits outside scope, (3) post-execution validator that auto-rejects diffs exceeding scope/size limits. Two-pass execution: planning pass outputs a JSON manifest, executor validates it, then execution pass works within the approved manifest.

**Tech Stack:** Node.js (evolution-executor.js on Pi), Bash (PreToolUse hook on EVO), Claude Code CLI flags (--allowedTools, --disallowedTools), .claude/settings.json on EVO repo.

**Problem:** Both evolution tasks so far touched 13-14 files (1000+ lines changed) for tasks that should have touched 1-3 files. Claude Code read the full CLAUDE.md, got "ideas", and rewrote overnight-report.js, engagement.js, index.js, handler.js, data files, and CLAUDE.md itself. The prompt was 6 vague bullet points with no enforcement.

---

### Task 1: Create EVOLUTION.md on EVO — scoped instruction file

**Files:**
- Create: `EVOLUTION.md` (new file in repo root, deployed to EVO)

Claude Code on EVO currently reads the full CLAUDE.md (474 lines of context about every subsystem). It doesn't need any of that for a scoped task. Create a minimal instruction file that Claude Code reads instead.

**Step 1: Create EVOLUTION.md**

```markdown
# EVOLUTION.md — Scope-Locked Coding Instructions

You are modifying the Clawdbot codebase via an automated evolution task.

## HARD RULES — VIOLATION = TASK FAILURE

1. **ONLY modify files listed in the SCOPE section below.** If a file is not in the scope, you MUST NOT edit, write, or create it. No exceptions.
2. **NEVER modify:** CLAUDE.md, EVOLUTION.md, .env, package.json, package-lock.json, any file in data/, any file in auth_state/, any .json file in the repo root.
3. **NEVER add new npm dependencies.** Only use packages already in package.json.
4. **NEVER change:** config.js env var names, tool definition schemas (tools/definitions.js), port numbers, API endpoints, auth logic.
5. **Max 100 lines changed total.** If your solution needs more, STOP and explain why in a comment. Do not proceed.
6. **One commit only.** Summarise what you changed and why.
7. **Read before writing.** Read each file you plan to modify FIRST. Understand the surrounding code. Do not guess at interfaces.
8. **If unsure, STOP.** Output a message explaining the ambiguity. Do not guess.

## SCOPE

The following files are in scope for this task. You may ONLY modify these files:

{{ALLOWED_FILES}}

## TASK

{{TASK_INSTRUCTION}}
```

**Step 2: Commit**

```bash
git add EVOLUTION.md
git commit -m "feat(evolution): add scoped instruction template for Claude Code"
```

---

### Task 2: Create PreToolUse hook script for EVO

**Files:**
- Create: `evo-hooks/scope-guard.sh` (new file, deployed to EVO at `~/clawdbot-claude-code/evo-hooks/`)

This script runs before every Edit, Write, and Bash call by Claude Code on EVO. It reads the allowed file list from `/tmp/evo-task-scope.json` and blocks any operation targeting a file outside scope.

**Step 1: Create the hook script**

```bash
#!/usr/bin/env bash
# evo-hooks/scope-guard.sh — PreToolUse hook for evolution tasks
# Blocks edits/writes/bash-writes to files not in the task scope.
# Reads allowed files from /tmp/evo-task-scope.json
# Exit 0 = allow, Exit 2 = block (Claude Code cancels the action)

set -euo pipefail

SCOPE_FILE="/tmp/evo-task-scope.json"

# If no scope file, block everything (safety default)
if [ ! -f "$SCOPE_FILE" ]; then
  echo "BLOCKED: No scope file found at $SCOPE_FILE. Cannot proceed." >&2
  exit 2
fi

# Read the hook input from stdin
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty')

# --- Edit / Write: check file_path ---
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "MultiEdit" ]]; then
  FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')

  if [ -z "$FILE_PATH" ]; then
    echo "BLOCKED: No file_path in $TOOL_NAME call." >&2
    exit 2
  fi

  # Normalise to relative path
  FILE_PATH="${FILE_PATH#/home/james/clawdbot-claude-code/}"

  # Check against allowed files
  ALLOWED=$(jq -r --arg f "$FILE_PATH" '.allowed_files[] | select(. == $f)' "$SCOPE_FILE")

  if [ -z "$ALLOWED" ]; then
    echo "BLOCKED: $FILE_PATH is not in the task scope. Allowed files: $(jq -r '.allowed_files | join(", ")' "$SCOPE_FILE")" >&2
    exit 2
  fi

  exit 0
fi

# --- Bash: block file-mutating commands targeting out-of-scope files ---
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty')

  # Block commands that write to files
  # Match: sed -i, awk (with >), echo/cat/tee writing to files, mv, cp, rm
  DANGEROUS_PATTERNS="sed -i|> |>> |tee |mv |cp |rm "

  if echo "$COMMAND" | grep -qE "$DANGEROUS_PATTERNS"; then
    # Extract potential target files from the command
    # This is best-effort — we check if any non-scope file appears as a target
    BANNED_FILES=("CLAUDE.md" "EVOLUTION.md" ".env" "package.json" "package-lock.json")

    for BANNED in "${BANNED_FILES[@]}"; do
      if echo "$COMMAND" | grep -q "$BANNED"; then
        echo "BLOCKED: Bash command targets banned file: $BANNED" >&2
        exit 2
      fi
    done

    # Check if command targets data/ directory
    if echo "$COMMAND" | grep -qE "data/|auth_state/"; then
      echo "BLOCKED: Bash command targets protected directory (data/ or auth_state/)" >&2
      exit 2
    fi
  fi

  # Allow read-only bash commands (ls, cat, grep, git diff, node --check, etc.)
  exit 0
fi

# All other tools (Read, Grep, Glob, etc.) — allow
exit 0
```

**Step 2: Make executable**

```bash
chmod +x evo-hooks/scope-guard.sh
```

**Step 3: Commit**

```bash
git add evo-hooks/scope-guard.sh
git commit -m "feat(evolution): add PreToolUse scope guard hook"
```

---

### Task 3: Create .claude/settings.json for EVO repo

**Files:**
- Create: `.claude/settings.json` (in repo root, deployed to EVO)

This configures Claude Code on EVO to use the scope guard hook.

**Step 1: Create settings file**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash /home/james/clawdbot-claude-code/evo-hooks/scope-guard.sh"
          }
        ]
      }
    ]
  }
}
```

**Step 2: Commit**

```bash
mkdir -p .claude
git add .claude/settings.json
git commit -m "feat(evolution): configure PreToolUse hook in Claude Code settings"
```

---

### Task 4: Rewrite evolution-executor.js — two-pass execution + post-validation

**Files:**
- Modify: `src/evolution-executor.js` (complete rewrite)

This is the core change. Two-pass execution:
- Pass 1 (PLAN): Claude Code outputs a JSON manifest: which files to modify, estimated lines, approach summary. No code changes.
- Validate the manifest against scope rules. Reject if too broad.
- Pass 2 (EXECUTE): Claude Code implements the plan, constrained to the approved files. PreToolUse hook enforces at runtime.
- Post-validation: check the actual diff against the manifest. Auto-reject if violated.

**Step 1: Rewrite evolution-executor.js**

```javascript
// src/evolution-executor.js — Runs Claude Code CLI on EVO via SSH
//
// Two-pass execution:
//   Pass 1 (PLAN):  Claude outputs JSON manifest of files + approach
//   Validate:       Check manifest against scope rules
//   Pass 2 (EXECUTE): Claude implements within approved scope
//   Post-validate:  Verify diff matches manifest
//
// Hard enforcement via PreToolUse hook (evo-hooks/scope-guard.sh)

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import logger from './logger.js';

const EVO_HOST = '10.0.0.2';
const EVO_USER = 'james';
const EVO_REPO = '/home/james/clawdbot-claude-code';
const CLAUDE_BIN = '/home/james/.local/bin/claude';
const SSH_OPTS = '-o ConnectTimeout=10 -o StrictHostKeyChecking=no';
const SCOPE_FILE = '/tmp/evo-task-scope.json';

// Limits
const MAX_PLAN_RUNTIME_MS = 2 * 60 * 1000;   // 2 min for planning
const MAX_EXEC_RUNTIME_MS = 5 * 60 * 1000;    // 5 min for execution
const MAX_FILES = 5;                            // max files per task
const MAX_LINES = 150;                          // max total lines changed
const BANNED_FILES = [
  'CLAUDE.md', 'EVOLUTION.md', '.env', 'package.json', 'package-lock.json',
  'data/', 'auth_state/', '.claude/', 'evo-hooks/', 'evo-evolve/',
  'node_modules/', 'docs/'
];

function ssh(cmd, timeoutMs = 30000) {
  return execSync(
    `ssh ${SSH_OPTS} ${EVO_USER}@${EVO_HOST} '${cmd.replace(/'/g, "'\\''")}'`,
    { encoding: 'utf-8', timeout: timeoutMs, stdio: 'pipe' }
  ).trim();
}

function syncToEvo() {
  try {
    execSync(
      `rsync -az --timeout=30 --exclude node_modules --exclude .baileys --exclude 'data/conversation-logs' /home/pi/clawdbot/ ${EVO_USER}@${EVO_HOST}:${EVO_REPO}/`,
      { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' }
    );
    logger.info('evolution: synced Pi -> EVO');
  } catch (err) {
    logger.warn({ err: err.message }, 'evolution: rsync to EVO failed, using existing EVO code');
  }
}

/**
 * Check if a file path is banned from modification.
 */
function isBanned(filePath) {
  const normalised = filePath.replace(/^\//, '').replace(/^home\/james\/clawdbot-claude-code\//, '');
  return BANNED_FILES.some(banned => {
    if (banned.endsWith('/')) return normalised.startsWith(banned);
    return normalised === banned;
  });
}

/**
 * Write the scope file to EVO so the PreToolUse hook can read it.
 */
function writeScopeFile(allowedFiles) {
  const scopeJson = JSON.stringify({ allowed_files: allowedFiles });
  ssh(`echo '${scopeJson.replace(/'/g, "'\\''")}' > ${SCOPE_FILE}`);
  logger.info({ files: allowedFiles }, 'evolution: scope file written');
}

/**
 * Clean up scope file after execution.
 */
function cleanScopeFile() {
  try { ssh(`rm -f ${SCOPE_FILE}`); } catch {}
}

/**
 * PASS 1: Planning — Claude outputs a JSON manifest, no code changes.
 */
async function planPass(instruction) {
  const prompt = [
    'You are planning a code change for the Clawdbot codebase.',
    'Read EVOLUTION.md for the rules.',
    '',
    'TASK: ' + instruction,
    '',
    'OUTPUT ONLY a valid JSON object with this exact schema (no markdown, no commentary):',
    '{',
    '  "files_to_modify": ["src/example.js", "src/other.js"],',
    '  "estimated_lines_changed": 42,',
    '  "approach": "Brief description of what you will change and why",',
    '  "risks": "What could go wrong"',
    '}',
    '',
    'Before outputting, READ the files you plan to modify to confirm they exist and understand their structure.',
    'Do NOT write any code. Do NOT modify any files. Output ONLY the JSON.',
  ].join('\\n');

  const output = ssh(
    `cd ${EVO_REPO} && export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2- | tr -d '"' | tr -d "'") && ${CLAUDE_BIN} -p '${prompt.replace(/'/g, "'\\''")}' --dangerously-skip-permissions --output-format text --max-turns 10 2>&1 || true`,
    MAX_PLAN_RUNTIME_MS
  );

  // Extract JSON from output (Claude may wrap it in markdown)
  const jsonMatch = output.match(/\{[\s\S]*"files_to_modify"[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Planning pass did not return valid JSON. Output: ' + output.slice(0, 500));
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error('Planning pass returned invalid JSON: ' + err.message);
  }
}

/**
 * Validate the manifest against scope rules.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateManifest(manifest, instruction) {
  const { files_to_modify, estimated_lines_changed } = manifest;

  if (!Array.isArray(files_to_modify) || files_to_modify.length === 0) {
    return { valid: false, reason: 'No files listed in manifest' };
  }

  if (files_to_modify.length > MAX_FILES) {
    return { valid: false, reason: `Too many files: ${files_to_modify.length} (max ${MAX_FILES})` };
  }

  if (estimated_lines_changed > MAX_LINES) {
    return { valid: false, reason: `Too many lines: ${estimated_lines_changed} (max ${MAX_LINES})` };
  }

  // Check for banned files
  for (const file of files_to_modify) {
    if (isBanned(file)) {
      return { valid: false, reason: `Banned file in manifest: ${file}` };
    }
  }

  // Check files are under src/ or eval/ (the only deployable directories)
  for (const file of files_to_modify) {
    if (!file.startsWith('src/') && !file.startsWith('eval/')) {
      return { valid: false, reason: `File outside deployable directories (src/, eval/): ${file}` };
    }
  }

  return { valid: true };
}

/**
 * PASS 2: Execution — Claude implements the plan within approved scope.
 */
async function executePass(instruction, manifest, branch) {
  // Build the EVOLUTION.md content with scope filled in
  const evolutionTemplate = ssh(`cat ${EVO_REPO}/EVOLUTION.md`, 10000);
  const scopedEvolution = evolutionTemplate
    .replace('{{ALLOWED_FILES}}', manifest.files_to_modify.map(f => `- ${f}`).join('\n'))
    .replace('{{TASK_INSTRUCTION}}', instruction);

  // Write scoped EVOLUTION.md to a temp location Claude Code will read
  const escapedEvolution = scopedEvolution.replace(/'/g, "'\\''").replace(/\n/g, '\\n');
  ssh(`echo -e '${escapedEvolution}' > ${EVO_REPO}/.evolution-scope.md`);

  // Write scope file for the PreToolUse hook
  writeScopeFile(manifest.files_to_modify);

  const prompt = [
    'Read .evolution-scope.md for your task and scope rules. Follow them exactly.',
    'Your approved plan: ' + manifest.approach,
    'You may ONLY modify these files: ' + manifest.files_to_modify.join(', '),
    'Implement the change now. Commit when done.',
  ].join('\\n');

  const output = ssh(
    `cd ${EVO_REPO} && git checkout ${branch} && export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY ~/.bashrc | cut -d= -f2- | tr -d '"' | tr -d "'") && ${CLAUDE_BIN} -p '${prompt.replace(/'/g, "'\\''")}' --dangerously-skip-permissions --output-format json --max-turns 20 2>&1 || true`,
    MAX_EXEC_RUNTIME_MS
  );

  // Clean up temp files
  try { ssh(`rm -f ${EVO_REPO}/.evolution-scope.md`); } catch {}
  cleanScopeFile();

  return output;
}

/**
 * Post-validation: check the actual diff against the approved manifest.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function postValidate(manifest) {
  const filesChanged = ssh(`cd ${EVO_REPO} && git diff main --name-only`)
    .split('\n')
    .filter(f => f.trim());

  if (!filesChanged.length) {
    return { valid: false, reason: 'No changes produced' };
  }

  // Check for out-of-scope files
  const outOfScope = filesChanged.filter(f => !manifest.files_to_modify.includes(f));
  if (outOfScope.length > 0) {
    return { valid: false, reason: `Files outside approved scope: ${outOfScope.join(', ')}` };
  }

  // Check total lines changed
  const diffStat = ssh(`cd ${EVO_REPO} && git diff main --shortstat`);
  const linesMatch = diffStat.match(/(\d+) insertion|(\d+) deletion/g);
  let totalLines = 0;
  if (linesMatch) {
    for (const m of linesMatch) {
      totalLines += parseInt(m.match(/\d+/)[0]);
    }
  }

  if (totalLines > MAX_LINES) {
    return { valid: false, reason: `Too many lines changed: ${totalLines} (max ${MAX_LINES})` };
  }

  // Check for banned files (belt and suspenders)
  for (const file of filesChanged) {
    if (isBanned(file)) {
      return { valid: false, reason: `Banned file modified: ${file}` };
    }
  }

  return { valid: true, files: filesChanged, totalLines };
}

/**
 * Main entry point: execute a coding task via two-pass Claude Code on EVO.
 */
export async function executeEvolutionTask(task) {
  const { id, instruction, branch } = task;

  logger.info({ taskId: id, branch }, 'evolution: starting two-pass execution');

  // 1. Sync Pi codebase to EVO
  syncToEvo();

  // 2. Create branch
  try {
    ssh(`cd ${EVO_REPO} && git checkout main 2>/dev/null; git checkout -b ${branch} 2>/dev/null || git checkout ${branch}`);
    logger.info({ branch }, 'evolution: branch ready');
  } catch (err) {
    throw new Error(`Git branch setup failed: ${err.message}`);
  }

  // 3. PASS 1: Planning
  let manifest;
  try {
    manifest = await planPass(instruction);
    logger.info({ taskId: id, manifest }, 'evolution: plan received');
  } catch (err) {
    try { ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch}`); } catch {}
    throw new Error(`Planning pass failed: ${err.message}`);
  }

  // 4. Validate manifest
  const validation = validateManifest(manifest, instruction);
  if (!validation.valid) {
    try { ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch}`); } catch {}
    throw new Error(`Manifest rejected: ${validation.reason}`);
  }

  logger.info({ taskId: id, files: manifest.files_to_modify, lines: manifest.estimated_lines_changed }, 'evolution: manifest approved');

  // 5. PASS 2: Execution
  let claudeOutput;
  try {
    claudeOutput = await executePass(instruction, manifest, branch);
    logger.info({ taskId: id, outputLen: claudeOutput.length }, 'evolution: execution pass completed');
  } catch (err) {
    cleanScopeFile();
    try { ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch}`); } catch {}
    throw new Error(`Execution pass failed: ${err.message}`);
  }

  // 6. Post-validation
  const postResult = postValidate(manifest);
  if (!postResult.valid) {
    logger.warn({ taskId: id, reason: postResult.reason }, 'evolution: post-validation FAILED — auto-rejecting');
    try { ssh(`cd ${EVO_REPO} && git checkout main && git branch -D ${branch}`); } catch {}
    throw new Error(`Post-validation failed: ${postResult.reason}`);
  }

  // 7. Collect diff for approval
  let diff, summary;
  try {
    diff = ssh(`cd ${EVO_REPO} && git diff main --stat && echo '---FULL---' && git diff main`, 60000);
    const statLines = diff.split('---FULL---')[0].trim();
    summary = statLines || 'No changes detected';
    diff = diff.split('---FULL---')[1]?.trim() || '';
  } catch (err) {
    diff = '';
    summary = 'Could not extract diff';
  }

  return {
    branch,
    diff,
    summary,
    files: postResult.files,
    totalLines: postResult.totalLines,
    manifest,
    claudeOutput: claudeOutput.slice(0, 5000),
  };
}

/**
 * Deploy approved changes from EVO branch to Pi.
 * Unchanged from original — merge, rsync src/, restart, health check.
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

  // 2. Rsync changed files back to Pi (only src/ and eval/)
  try {
    for (const file of files_changed) {
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

  // 4. Health check
  await new Promise(resolve => setTimeout(resolve, 5000));
  try {
    const status = execSync('systemctl is-active clawdbot', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (status !== 'active') throw new Error(`Service not active: ${status}`);
    logger.info('evolution: health check passed');
  } catch (err) {
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
  try { ssh(`cd ${EVO_REPO} && git branch -D ${branch}`); } catch {}

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
  } catch {}
}
```

**Step 2: Commit**

```bash
git add src/evolution-executor.js
git commit -m "feat(evolution): rewrite executor with two-pass execution + post-validation"
```

---

### Task 5: Update evolution.js — add manifest field to task schema

**Files:**
- Modify: `src/evolution.js` (add manifest field, update approval message)

**Step 1: Add manifest to task creation and approval message**

In `createTask()`, no changes needed — manifest is added by the executor via `updateTask()`.

In `formatApprovalMessage()`, add manifest summary to the approval DM:

Find the current `formatApprovalMessage` function and update it to include the manifest info (files planned, lines estimated) alongside the diff summary. The message James sees should clearly show:
- Which files were in scope (from manifest)
- How many lines actually changed
- The diff stat

**Step 2: Commit**

```bash
git add src/evolution.js
git commit -m "feat(evolution): include manifest in approval messages"
```

---

### Task 6: Update run-evolution.sh — apply same hardening to overnight sessions

**Files:**
- Modify: `evo-evolve/run-evolution.sh`

The overnight script has the same problem — a broad prompt and no scope enforcement. Apply the same discipline:

**Step 1: Update the overnight prompt**

Replace the current EVOLUTION_PROMPT (lines 130-165) with a version that:
- Tells Claude Code to read EVOLUTION.md instead of CLAUDE.md
- Enforces one-change-at-a-time: "Pick the SINGLE most impactful fix from the health report. Do not batch multiple fixes."
- Includes the same hard rules (max files, max lines, banned files)
- Writes scope file before running Claude Code
- Post-validates the diff after Claude Code finishes
- If post-validation fails, deletes the branch and notes it in the summary

**Step 2: Add scope file writing before Claude Code invocation**

Before the `timeout "$MAX_DURATION" claude -p ...` line, add:
```bash
# Write empty scope file — Claude Code planning pass will determine scope
echo '{"allowed_files": []}' > /tmp/evo-task-scope.json
```

After Claude Code finishes, add post-validation:
```bash
# Post-validate: check diff against limits
FILES_CHANGED=$(git diff --name-only main.."$BRANCH" 2>/dev/null | wc -l)
LINES_CHANGED=$(git diff --shortstat main.."$BRANCH" 2>/dev/null | grep -oP '\d+ insertion' | grep -oP '\d+' || echo 0)

if [ "$FILES_CHANGED" -gt 5 ]; then
  echo "POST-VALIDATION FAILED: $FILES_CHANGED files changed (max 5)" | tee -a "$LOG_FILE"
  git checkout main && git branch -D "$BRANCH"
  exit 1
fi
```

**Step 3: Commit**

```bash
git add evo-evolve/run-evolution.sh
git commit -m "feat(evolution): harden overnight script with scope limits and post-validation"
```

---

### Task 7: Deploy hook infrastructure to EVO

**Files:**
- Deploy: `EVOLUTION.md` to EVO
- Deploy: `evo-hooks/scope-guard.sh` to EVO
- Deploy: `.claude/settings.json` to EVO
- Verify: hook triggers correctly

**Step 1: Deploy files to EVO via Pi SSH hop**

```bash
# From local machine
scp -i C:/Users/James/.ssh/id_ed25519 EVOLUTION.md pi@192.168.1.211:/tmp/EVOLUTION.md
scp -i C:/Users/James/.ssh/id_ed25519 evo-hooks/scope-guard.sh pi@192.168.1.211:/tmp/scope-guard.sh
scp -i C:/Users/James/.ssh/id_ed25519 .claude/settings.json pi@192.168.1.211:/tmp/claude-settings.json

# Hop to EVO
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "
  scp /tmp/EVOLUTION.md james@10.0.0.2:~/clawdbot-claude-code/EVOLUTION.md
  ssh james@10.0.0.2 'mkdir -p ~/clawdbot-claude-code/evo-hooks ~/clawdbot-claude-code/.claude'
  scp /tmp/scope-guard.sh james@10.0.0.2:~/clawdbot-claude-code/evo-hooks/scope-guard.sh
  scp /tmp/claude-settings.json james@10.0.0.2:~/clawdbot-claude-code/.claude/settings.json
  ssh james@10.0.0.2 'chmod +x ~/clawdbot-claude-code/evo-hooks/scope-guard.sh'
"
```

**Step 2: Verify jq is installed on EVO (required by hook)**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@10.0.0.2 'which jq || sudo apt install -y jq'"
```

**Step 3: Test the hook manually**

```bash
# Create a test scope file
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "ssh james@10.0.0.2 '
  echo '\\''{ \"allowed_files\": [\"src/trigger.js\"] }'\\'' > /tmp/evo-task-scope.json
  echo '\\''{ \"tool_name\": \"Edit\", \"tool_input\": { \"file_path\": \"src/trigger.js\" } }'\\'' | bash ~/clawdbot-claude-code/evo-hooks/scope-guard.sh
  echo \"Exit code for allowed file: \$?\"
  echo '\\''{ \"tool_name\": \"Edit\", \"tool_input\": { \"file_path\": \"CLAUDE.md\" } }'\\'' | bash ~/clawdbot-claude-code/evo-hooks/scope-guard.sh
  echo \"Exit code for banned file: \$?\"
  rm /tmp/evo-task-scope.json
'"
```

Expected: first test exits 0 (allowed), second exits 2 (blocked).

---

### Task 8: Deploy updated executor to Pi + smoke test

**Files:**
- Deploy: `src/evolution-executor.js` to Pi
- Deploy: `src/evolution.js` to Pi (if modified)
- Test: Create a test evolution task and verify two-pass flow

**Step 1: Deploy to Pi**

```bash
scp -i C:/Users/James/.ssh/id_ed25519 src/evolution-executor.js pi@192.168.1.211:~/clawdbot/src/evolution-executor.js
scp -i C:/Users/James/.ssh/id_ed25519 src/evolution.js pi@192.168.1.211:~/clawdbot/src/evolution.js
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sudo systemctl restart clawdbot"
```

**Step 2: Verify service starts cleanly**

```bash
ssh -i C:/Users/James/.ssh/id_ed25519 pi@192.168.1.211 "sleep 3 && journalctl -u clawdbot --no-pager -n 10"
```

**Step 3: Smoke test — submit a tightly scoped evolution task via WhatsApp**

Send James a message asking him to test with: "Hey Clawd, evolution task: Add a debug log line at the top of the handleMessage function in src/trigger.js that logs the raw message text"

This should:
1. Planning pass: output `{ files_to_modify: ["src/trigger.js"], estimated_lines_changed: 2 }`
2. Manifest validation: pass (1 file, 2 lines, src/ directory)
3. Execution pass: add the log line
4. Post-validation: pass (1 file changed, <150 lines)
5. DM James with the diff for approval

---

### Task 9: Update CLAUDE.md with new design decisions

**Files:**
- Modify: `CLAUDE.md`

Add design decisions documenting the hardening:

```
### Evolution Hardening (2026-03-25)
71. **Two-pass evolution execution.** Pass 1: Claude Code outputs a JSON manifest (files, lines, approach). Pass 2: executes within approved scope only. Manifest rejected if >5 files or >150 lines.
72. **PreToolUse hook enforces scope on EVO.** `evo-hooks/scope-guard.sh` reads `/tmp/evo-task-scope.json` and hard-blocks (exit 2) any Edit/Write/Bash-write to files outside the approved list.
73. **Post-validation auto-rejects scope violations.** After execution, `git diff --name-only` is checked against the manifest. Any out-of-scope file = auto-reject + branch deletion.
74. **EVOLUTION.md replaces CLAUDE.md for Claude Code.** Claude Code on EVO reads EVOLUTION.md (scoped task instructions) not the full CLAUDE.md. Prevents context-driven scope creep.
75. **Banned files list is code-level, not prompt-level.** CLAUDE.md, .env, package.json, data/, auth_state/ are blocked by isBanned() in evolution-executor.js AND by the PreToolUse hook. Belt and suspenders.
```
