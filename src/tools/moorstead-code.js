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
  const request = (input.request || '').trim();
  if (!request) return 'request is required — describe the change you want in plain English.';
  if (request.length > 500) {
    return `request is too long (${request.length} chars, max 500). Please be more concise.`;
  }

  // Encode request to avoid shell-quoting issues
  const b64Request = Buffer.from(request).toString('base64');
  const jobId = generateJobId();

  // Runner command — EVO-side script receives jobId and base64-encoded request.
  // The runner: decodes request, generates code via local LLM, runs classifyChange,
  // verifies (npm test), and applies or proposes depending on its own apply flag.
  const runnerBase = config.moorsteadCodeRunner || 'bash /home/james/moorstead/autocode/run.sh';
  const command = `${runnerBase} ${jobId} ${b64Request}`;

  const confirmId = storeCode(request, jobId, command);

  const applyNote = config.moorsteadCodeApply
    ? '⚡ Auto-apply is ENABLED — runner will deploy if gate is green/amber + tests pass.'
    : '📋 Proposal-only mode (MOORSTEAD_CODE_APPLY is false) — runner will generate and gate but NOT deploy.';

  return [
    `🛠️ *Moorstead auto-coder — staged request*`,
    ``,
    `*Request:* ${request}`,
    ``,
    `*Gate envelope:*`,
    `  • Hard-locked (never): worldgen, geography, noise, sky, landmarks, rails, defs, multiplayer, player, package.json, any auth/admin/secret path, build/deploy infrastructure, .py files`,
    `  • Red if >4 files or >150 lines changed`,
    `  • Amber (confirm required): additive content within caps`,
    `  • Green (auto-eligible): ≤2 files, ≤60 lines, content-only paths (entities.js, npc.js, new src/ files)`,
    ``,
    `${applyNote}`,
    ``,
    `*Job ID:* \`${jobId}\``,
    `*Confirm ID:* \`${confirmId}\``,
    ``,
    `This is a DRY-RUN proposal. Call *moorstead_code_confirm* with confirm_id \`${confirmId}\` to dispatch the runner.`,
    `Expires in 10 minutes.`,
  ].join('\n');
}

/**
 * moorstead_code_confirm — consume pending op, check gate, exec runner.
 * input: { confirm_id: string }
 */
export async function moorsteadCodeConfirm(input) {
  const confirmId = (input.confirm_id || '').trim();
  if (!confirmId) {
    return 'confirm_id is required. Use moorstead_code first to stage a request.';
  }

  const entry = consumeCode(confirmId);
  if (!entry) {
    return (
      `No pending auto-coder request with id \`${confirmId}\` ` +
      `(expired, already used, or never existed). ` +
      `Run moorstead_code again if you still want to proceed.`
    );
  }

  if (!config.moorsteadCodeEnabled) {
    return (
      `Auto-coder is disabled. Set MOORSTEAD_CODE_ENABLED=true in the bot environment to enable it. ` +
      `The request "${entry.request}" has been discarded.`
    );
  }

  try {
    const { stdout, stderr } = await _execFn(entry.command, {
      shell: '/bin/bash',
      timeout: 5 * 60 * 1000, // 5-minute runner timeout
    });
    const out = (stdout || '').trim();
    const err = (stderr || '').trim();
    const lines = [];
    if (out) lines.push(out);
    if (err) lines.push(`stderr: ${err}`);
    const detail = lines.length > 0 ? lines.join('\n') : '(runner produced no output)';
    return `✅ *Auto-coder runner dispatched* (job \`${entry.jobId}\`)\n\n${detail}`;
  } catch (err) {
    const msg = err.message || String(err);
    const stderr = (err.stderr || '').trim();
    return (
      `❌ Auto-coder runner failed (job \`${entry.jobId}\`).\n` +
      `Command: \`${entry.command}\`\n` +
      `Error: ${msg}` +
      (stderr ? `\nstderr: ${stderr}` : '')
    );
  }
}
