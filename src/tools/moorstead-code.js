// src/tools/moorstead-code.js
// Owner-only, confirm-gated Moorstead auto-coder tool.
//
// Two-step flow mirroring moorstead.js PENDING_OPS pattern:
//   1. moorstead_code_stage   — validates NL request, builds runner command, stores pending, returns proposal + confirm_id.
//   2. moorstead_code_confirm — consumes pending, checks config gate, execs runner, returns stdout.
//
// The runner (EVO-side) receives: jobId + base64-encoded request.
// It generates code, gates it through classifyChange (its own copy), verifies, and optionally deploys.
// This clawdbot side is purely a mechanical safety gate and dispatch relay — it never touches the game source.

import { exec as _nodeExec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import config from '../config.js';

// ── Confirm gate ─────────────────────────────────────────────────────────────

const PENDING_CODE = new Map(); // confirm_id → { request, jobId, command, expiresAt }
const PENDING_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/** Exec wrapper — injectable for tests, defaults to child_process.exec */
let _execFn = promisify(_nodeExec);

/** For tests: replace the exec function used by the confirm handler */
export function _setExecFn(fn) {
  _execFn = fn;
}

function generateConfirmId() {
  return randomBytes(4).toString('hex');
}

function storeCode(request, jobId, command) {
  const confirmId = generateConfirmId();
  PENDING_CODE.set(confirmId, {
    request,
    jobId,
    command,
    expiresAt: Date.now() + PENDING_EXPIRY_MS,
  });
  return confirmId;
}

function consumeCode(confirmId) {
  const entry = PENDING_CODE.get(confirmId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    PENDING_CODE.delete(confirmId);
    return null;
  }
  PENDING_CODE.delete(confirmId);
  return entry;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a short unique job id (8 hex chars, different from confirm_id) */
function generateJobId() {
  return randomBytes(4).toString('hex');
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * moorstead_code_stage — validate request, build runner command, store pending, return proposal.
 * input: { request: string }
 */
export async function moorsteadCodeStage(input) {
  // Accept the request under any of the common param names a model might pick
  // (MiniMax has been seen to send `text` rather than `request`).
  const request = (
    input.request || input.text || input.change || input.description ||
    input.spec || input.prompt || input.task || ''
  ).trim();
  if (!request) {
    return 'Tell me what to add, e.g. "add a hedgehog that snuffles in the hedgerows at dusk".';
  }
  if (request.length > 500) {
    return `That request is ${request.length} chars; keep it under 500 and I'll get on it.`;
  }
  if (!config.moorsteadCodeEnabled) {
    return 'The Moorstead auto-coder is switched off (set MOORSTEAD_CODE_ENABLED=true to enable it).';
  }

  // One-step: dispatch the EVO runner directly. It generates the change via
  // Claude Code @ MiniMax M3 in an isolated worktree, runs the mechanical gate
  // (worldgen/geography/protocol/auth etc. are hard-blocked), verifies + builds,
  // and ONLY deploys if its own MOORSTEAD_CODE_APPLY=1 (else proposal-only).
  // No separate confirm step — the apply flag is the real safety gate.
  const b64Request = Buffer.from(request).toString('base64');
  const jobId = generateJobId();
  const runnerBase = config.moorsteadCodeRunner || 'bash /home/james/moorstead/autocode/run.sh';
  const command = `${runnerBase} ${jobId} ${b64Request}`;
  const mode = config.moorsteadCodeApply ? 'apply ENABLED (will deploy if green + builds)' : 'proposal-only';

  try {
    const { stdout, stderr } = await _execFn(command, {
      shell: '/bin/bash',
      timeout: 290 * 1000,
      maxBuffer: 1024 * 1024,
    });
    const out = (stdout || '').trim();
    const err = (stderr || '').trim();
    const body = out || (err ? `stderr: ${err}` : '(runner produced no output)');
    return `🛠️ *Moorstead auto-coder* (job \`${jobId}\`, ${mode})\n\n${body}`;
  } catch (e) {
    const msg = e.message || String(e);
    const se = (e.stderr || '').toString().trim();
    return `❌ Auto-coder failed (job \`${jobId}\`): ${msg}${se ? `\n${se.slice(0, 300)}` : ''}`;
  }
}

/**
 * moorstead_code_confirm — consume pending op, check gate, exec runner.
 * input: { confirm_id: string }
 */
export async function moorsteadCodeConfirm() {
  // Deprecated: moorstead_code now runs the auto-coder in one step. Kept so any
  // stray confirm call returns a helpful nudge rather than an error.
  return 'No confirm step any more — moorstead_code runs the auto-coder directly (proposal-only unless apply is enabled). Just call moorstead_code with your request.';
}
