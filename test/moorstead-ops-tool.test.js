// test/moorstead-ops-tool.test.js
// Tests for moorstead_ops (stage) and moorstead_ops_confirm (execute).
// Uses node:test; mocks child_process via the exported _setExecFn hook.
// Never calls real exec; never touches the network.

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// ── Module load ───────────────────────────────────────────────────────────────
// Dynamic import so config sees env vars before first evaluation.

let moorsteadOps, moorsteadOpsConfirm, _setExecFn;

before(async () => {
  const mod = await import('../src/tools/moorstead.js');
  moorsteadOps = mod.moorsteadOps;
  moorsteadOpsConfirm = mod.moorsteadOpsConfirm;
  _setExecFn = mod._setExecFn;
});

// ── Exec mock helpers ─────────────────────────────────────────────────────────

/** Install a no-op exec that records calls but never runs anything. */
function noExecInstalled() {
  const calls = [];
  _setExecFn(async (cmd, _opts) => {
    calls.push(cmd);
    throw new Error('exec must not be called before confirmation');
  });
  return calls;
}

/** Install a successful exec mock. Returns an array that captures each command. */
function successExec(stdout = '', stderr = '') {
  const calls = [];
  _setExecFn(async (cmd, _opts) => {
    calls.push(cmd);
    return { stdout, stderr };
  });
  return calls;
}

/** Install a failing exec mock. */
function failExec(message, stderr = '') {
  _setExecFn(async (_cmd, _opts) => {
    const err = new Error(message);
    err.stderr = stderr;
    throw err;
  });
}

afterEach(() => {
  // Reset exec to a sentinel that throws if accidentally called between tests
  _setExecFn(async () => { throw new Error('exec called outside test'); });
});

// ── Helper: extract confirm_id from a staging result ─────────────────────────

function extractConfirmId(msg) {
  const m = msg.match(/`([0-9a-f]{8})`/);
  assert.ok(m, `No 8-char hex confirm_id found in:\n${msg}`);
  return m[1];
}

// ═════════════════════════════════════════════════════════════════════════════
// A. Staging — returns warning; exec NOT called
// ═════════════════════════════════════════════════════════════════════════════

describe('moorstead_ops staging (no exec)', () => {
  it('restart_service: returns warning with confirm_id, does NOT exec', async () => {
    const calls = noExecInstalled();

    const result = await moorsteadOps({ op: 'restart_service', service: 'relay' });

    // Must mention the unit and include a confirm_id
    assert.match(result, /moorstead-world/);
    assert.match(result, /RESTART/);
    assert.match(result, /[0-9a-f]{8}/); // confirm_id present
    assert.match(result, /moorstead_ops_confirm/);
    assert.equal(calls.length, 0, 'exec must not be called during staging');
  });

  it('reset_room: returns warning with backup mention and confirm_id, does NOT exec', async () => {
    const calls = noExecInstalled();

    const result = await moorsteadOps({ op: 'reset_room', room: 'moor' });

    assert.match(result, /RESET/);
    assert.match(result, /moor/);
    assert.match(result, /backup/i);
    assert.match(result, /[0-9a-f]{8}/);
    assert.match(result, /moorstead_ops_confirm/);
    assert.equal(calls.length, 0, 'exec must not be called during staging');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. Confirm with correct id — execs EXACT expected command
// ═════════════════════════════════════════════════════════════════════════════

describe('moorstead_ops_confirm with correct confirm_id', () => {
  it('restart_service(relay): execs "sudo systemctl restart moorstead-world"', async () => {
    // Stage first (exec mock irrelevant for staging step — install success mock now)
    const calls = successExec('', '');
    const staged = await moorsteadOps({ op: 'restart_service', service: 'relay' });
    const confirmId = extractConfirmId(staged);

    const result = await moorsteadOpsConfirm({ confirm_id: confirmId });

    assert.equal(calls.length, 1, 'exec should be called exactly once');
    assert.equal(calls[0], 'sudo systemctl restart moorstead-world');
    assert.match(result, /restart_service/);
    assert.match(result, /executed/i);
  });

  it('restart_service(brain): execs "sudo systemctl restart moorstead-brain"', async () => {
    const calls = successExec();
    const staged = await moorsteadOps({ op: 'restart_service', service: 'brain' });
    const confirmId = extractConfirmId(staged);

    await moorsteadOpsConfirm({ confirm_id: confirmId });

    assert.equal(calls[0], 'sudo systemctl restart moorstead-brain');
  });

  it('restart_service(dash): execs "sudo systemctl restart moorstead-dash"', async () => {
    const calls = successExec();
    const staged = await moorsteadOps({ op: 'restart_service', service: 'dash' });
    const confirmId = extractConfirmId(staged);
    await moorsteadOpsConfirm({ confirm_id: confirmId });
    assert.equal(calls[0], 'sudo systemctl restart moorstead-dash');
  });

  it('restart_service(body): execs "sudo systemctl restart clint-body"', async () => {
    const calls = successExec();
    const staged = await moorsteadOps({ op: 'restart_service', service: 'body' });
    const confirmId = extractConfirmId(staged);
    await moorsteadOpsConfirm({ confirm_id: confirmId });
    assert.equal(calls[0], 'sudo systemctl restart clint-body');
  });

  it('restart_service(clawdbot): execs "sudo systemctl restart clawdbot"', async () => {
    const calls = successExec();
    const staged = await moorsteadOps({ op: 'restart_service', service: 'clawdbot' });
    const confirmId = extractConfirmId(staged);
    await moorsteadOpsConfirm({ confirm_id: confirmId });
    assert.equal(calls[0], 'sudo systemctl restart clawdbot');
  });

  it('reset_room(moor): execs backup+delete+kill command containing the room name', async () => {
    const calls = successExec('', '');
    const staged = await moorsteadOps({ op: 'reset_room', room: 'moor' });
    const confirmId = extractConfirmId(staged);

    const result = await moorsteadOpsConfirm({ confirm_id: confirmId });

    assert.equal(calls.length, 1);
    // Command must contain these exact substrings
    assert.ok(calls[0].includes('mkdir -p ~/moorstead/world/resets'), `mkdir missing in: ${calls[0]}`);
    assert.ok(calls[0].includes('cp ~/moorstead/world/moor.json'), `cp missing in: ${calls[0]}`);
    assert.ok(calls[0].includes('resets/moor.'), `backup path missing in: ${calls[0]}`);
    assert.ok(calls[0].includes('rm -f ~/moorstead/world/moor.json'), `rm missing in: ${calls[0]}`);
    assert.ok(calls[0].includes('kill $(systemctl show -p MainPID --value moorstead-world.service)'), `kill missing in: ${calls[0]}`);
    assert.match(result, /reset_room/);
    assert.match(result, /executed/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. Confirm with wrong / expired / missing id — refuses without exec
// ═════════════════════════════════════════════════════════════════════════════

describe('moorstead_ops_confirm with wrong or missing confirm_id', () => {
  it('refuses if confirm_id is wrong hex', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOpsConfirm({ confirm_id: 'deadbeef' });
    assert.match(result, /No pending op/);
    assert.match(result, /deadbeef/);
    assert.equal(calls.length, 0);
  });

  it('refuses if confirm_id is empty string', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOpsConfirm({ confirm_id: '' });
    assert.match(result, /confirm_id is required/);
    assert.equal(calls.length, 0);
  });

  it('refuses if confirm_id is missing from input', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOpsConfirm({});
    assert.match(result, /confirm_id is required/);
    assert.equal(calls.length, 0);
  });

  it('refuses on second confirm with the same id (single-use)', async () => {
    const calls = successExec();
    const staged = await moorsteadOps({ op: 'restart_service', service: 'relay' });
    const confirmId = extractConfirmId(staged);

    // First confirm — should succeed
    const first = await moorsteadOpsConfirm({ confirm_id: confirmId });
    assert.match(first, /executed/i);
    assert.equal(calls.length, 1);

    // Second confirm — id consumed; should refuse
    failExec('should not reach exec');
    const second = await moorsteadOpsConfirm({ confirm_id: confirmId });
    assert.match(second, /No pending op/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Invalid params — rejected without staging (no confirm_id issued)
// ═════════════════════════════════════════════════════════════════════════════

describe('moorstead_ops input validation (invalid → no staging)', () => {
  it('rejects unknown service name', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'restart_service', service: 'hacker' });
    assert.match(result, /Unknown service/);
    assert.match(result, /hacker/);
    assert.equal(calls.length, 0);
  });

  it('rejects missing service name', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'restart_service' });
    assert.match(result, /service is required/);
    assert.equal(calls.length, 0);
  });

  it('rejects room name with uppercase letters', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'reset_room', room: 'Moor' });
    assert.match(result, /Invalid room name/);
    assert.equal(calls.length, 0);
  });

  it('rejects room name with numbers', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'reset_room', room: 'room1' });
    assert.match(result, /Invalid room name/);
    assert.equal(calls.length, 0);
  });

  it('rejects room name that is too short (1 char)', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'reset_room', room: 'a' });
    assert.match(result, /Invalid room name/);
    assert.equal(calls.length, 0);
  });

  it('rejects room name that is too long (>16 chars)', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'reset_room', room: 'averylongroomname' }); // 17 chars
    assert.match(result, /Invalid room name/);
    assert.equal(calls.length, 0);
  });

  it('rejects missing room name', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'reset_room' });
    assert.match(result, /room is required/);
    assert.equal(calls.length, 0);
  });

  it('rejects unknown op', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({ op: 'nuke_everything' });
    assert.match(result, /Unknown op/);
    assert.equal(calls.length, 0);
  });

  it('rejects missing op', async () => {
    const calls = noExecInstalled();
    const result = await moorsteadOps({});
    assert.match(result, /Unknown op/);
    assert.equal(calls.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. Exec error — returns clean error string, does not throw
// ═════════════════════════════════════════════════════════════════════════════

describe('moorstead_ops_confirm exec failure handling', () => {
  it('returns a clean error string when exec throws; does not throw out of handler', async () => {
    failExec('systemctl: permission denied', 'Unit not found');

    const staged = await moorsteadOps({ op: 'restart_service', service: 'relay' });
    const confirmId = extractConfirmId(staged);

    const result = await moorsteadOpsConfirm({ confirm_id: confirmId });

    // Must be a string (not a throw)
    assert.equal(typeof result, 'string');
    assert.match(result, /failed/i);
    assert.match(result, /systemctl: permission denied/);
    // Does not propagate — calling code will never see an unhandled rejection
    await assert.doesNotReject(async () => result);
  });

  it('includes stderr in failure output when present', async () => {
    failExec('non-zero exit', 'Unit moorstead-world.service not found.');

    const staged = await moorsteadOps({ op: 'restart_service', service: 'relay' });
    const confirmId = extractConfirmId(staged);
    const result = await moorsteadOpsConfirm({ confirm_id: confirmId });

    assert.match(result, /moorstead-world\.service not found/);
  });
});
