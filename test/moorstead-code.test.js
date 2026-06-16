// test/moorstead-code.test.js
// Tests for the one-step Moorstead auto-coder tool (src/tools/moorstead-code.js).
// Never calls real exec; never touches the network; never writes to disk.

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.MOORSTEAD_CODE_ENABLED = 'true'; // enable the exec path for these tests

let moorsteadCodeStage, moorsteadCodeConfirm, _setExecFn;

before(async () => {
  const mod = await import('../src/tools/moorstead-code.js');
  moorsteadCodeStage = mod.moorsteadCodeStage;
  moorsteadCodeConfirm = mod.moorsteadCodeConfirm;
  _setExecFn = mod._setExecFn;
});

function captureExec(stdout = 'gate:\ngreen\nverify + build passed\nPROPOSAL ONLY', stderr = '') {
  const calls = [];
  _setExecFn(async (cmd, opts) => { calls.push({ cmd, opts }); return { stdout, stderr }; });
  return calls;
}
function failExec(message, stderr = '') {
  _setExecFn(async () => { const e = new Error(message); e.stderr = stderr; throw e; });
}
afterEach(() => { _setExecFn(async () => { throw new Error('exec called outside test'); }); });

describe('moorstead_code — one-step run', () => {
  it('dispatches the runner and returns its output', async () => {
    const calls = captureExec();
    const result = await moorsteadCodeStage({ request: 'add a hedgehog that snuffles at dusk' });
    assert.equal(typeof result, 'string');
    assert.equal(calls.length, 1, 'runner should be dispatched exactly once');
    assert.match(result, /green|PROPOSAL/i);
    assert.match(result, /job/i);
  });

  it('accepts the request under alias param names', async () => {
    for (const key of ['text', 'change', 'description', 'spec', 'prompt', 'task']) {
      const calls = captureExec();
      await moorsteadCodeStage({ [key]: 'add a robin' });
      assert.equal(calls.length, 1, `alias "${key}" should dispatch the runner`);
      const b64 = Buffer.from('add a robin').toString('base64');
      assert.ok(calls[0].cmd.includes(b64), `command should embed base64 for alias "${key}"`);
    }
  });

  it('command embeds an 8-hex job id and the base64 request', async () => {
    const calls = captureExec();
    const req = 'add a barn owl that hunts at night';
    await moorsteadCodeStage({ request: req });
    assert.match(calls[0].cmd, /run\.sh\s+[0-9a-f]{8}\s+/);
    assert.ok(calls[0].cmd.includes(Buffer.from(req).toString('base64')));
  });

  it('empty / missing request → friendly prompt, no exec', async () => {
    const calls = captureExec();
    const r1 = await moorsteadCodeStage({});
    const r2 = await moorsteadCodeStage({ request: '' });
    assert.match(r1, /tell me what to add/i);
    assert.match(r2, /tell me what to add/i);
    assert.equal(calls.length, 0);
  });

  it('request over 500 chars → rejected, no exec', async () => {
    const calls = captureExec();
    const r = await moorsteadCodeStage({ request: 'a'.repeat(501) });
    assert.match(r, /under 500|500/i);
    assert.equal(calls.length, 0);
  });

  it('exec failure → clean error string with job id', async () => {
    failExec('runner not found', 'bash: run.sh: No such file');
    const r = await moorsteadCodeStage({ request: 'add a fox' });
    assert.equal(typeof r, 'string');
    assert.match(r, /failed/i);
    assert.match(r, /job/i);
  });

  it('never throws', async () => {
    captureExec();
    await assert.doesNotReject(async () => moorsteadCodeStage({ request: 'add a deer' }));
    await assert.doesNotReject(async () => moorsteadCodeStage({}));
    await assert.doesNotReject(async () => moorsteadCodeStage({ request: 'x'.repeat(1000) }));
  });
});

describe('moorstead_code_confirm — deprecated no-op', () => {
  it('returns a helpful nudge and never execs', async () => {
    const calls = captureExec();
    const r = await moorsteadCodeConfirm({ confirm_id: 'whatever' });
    assert.equal(typeof r, 'string');
    assert.match(r, /no confirm|directly/i);
    assert.equal(calls.length, 0);
  });
});
