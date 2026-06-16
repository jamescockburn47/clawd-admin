// test/moorstead-bairns-tool.test.js
// Tests for moorsteadBairnsStatus and moorsteadBairnsSet
// Uses node:test + mocked global fetch; never hits a real relay.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// Dynamic import so config initialisation (which reads process.env) has
// already seen our env vars when the module is first evaluated.
let moorsteadBairnsStatus;
let moorsteadBairnsSet;

async function loadModules() {
  const mod = await import('../src/tools/moorstead.js');
  moorsteadBairnsStatus = mod.moorsteadBairnsStatus;
  moorsteadBairnsSet = mod.moorsteadBairnsSet;
}

// --- fetch mock helpers ---

function mockFetch(status, body) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function mockFetchNetworkError(message) {
  globalThis.fetch = async () => { throw new Error(message); };
}

// Track what fetch was called with
function capturingFetch(status, body) {
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return () => captured;
}

// ============================================================
// moorsteadBairnsStatus
// ============================================================

describe('moorsteadBairnsStatus', () => {
  beforeEach(async () => {
    if (!moorsteadBairnsStatus) await loadModules();
  });

  it('formats with a time limit, a closed window, and today play data', async () => {
    mockFetch(200, {
      controls: {
        daily_limit_min: 60,
        warn_sec: 300,
        locked: false,
        closed: { from: '20:00', to: '07:00' },
      },
      closed_now: false,
      today_seconds: { pid1: 2460, pid2: 1200 },
    });
    const result = await moorsteadBairnsStatus();
    assert.match(result, /\*Bairns world\*/);
    assert.match(result, /limit: 60 min\/day/);
    assert.match(result, /Closed 20:00–07:00/);
    assert.match(result, /Open now/);
    assert.match(result, /2 bairns played/);
    // 2460 s = 41 m
    assert.match(result, /max 41m/);
  });

  it('says "no time limit" when daily_limit_min is 0', async () => {
    mockFetch(200, {
      controls: {
        daily_limit_min: 0,
        warn_sec: 60,
        locked: false,
        closed: null,
      },
      closed_now: false,
      today_seconds: {},
    });
    const result = await moorsteadBairnsStatus();
    assert.match(result, /no time limit/);
  });

  it('says "No closed window" when closed is null', async () => {
    mockFetch(200, {
      controls: { daily_limit_min: 30, warn_sec: 60, locked: false, closed: null },
      closed_now: false,
      today_seconds: {},
    });
    const result = await moorsteadBairnsStatus();
    assert.match(result, /No closed window/);
  });

  it('says "No play today" when today_seconds is empty', async () => {
    mockFetch(200, {
      controls: { daily_limit_min: 30, warn_sec: 60, locked: false, closed: null },
      closed_now: false,
      today_seconds: {},
    });
    const result = await moorsteadBairnsStatus();
    assert.match(result, /No play today/);
  });

  it('reports single bairn in singular form', async () => {
    mockFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 60, locked: false, closed: null },
      closed_now: false,
      today_seconds: { pid1: 900 },
    });
    const result = await moorsteadBairnsStatus();
    assert.match(result, /1 bairn played/);
  });

  it('returns a clean error string on HTTP 401', async () => {
    mockFetch(401, 'Unauthorized');
    const result = await moorsteadBairnsStatus();
    assert.match(result, /relay error 401/);
    assert.doesNotMatch(result, /throw|Error/);
  });

  it('returns a clean error string on network failure', async () => {
    mockFetchNetworkError('ECONNREFUSED');
    const result = await moorsteadBairnsStatus();
    assert.match(result, /bairns status failed/);
    assert.match(result, /ECONNREFUSED/);
  });
});

// ============================================================
// moorsteadBairnsSet
// ============================================================

describe('moorsteadBairnsSet — POST body construction', () => {
  beforeEach(async () => {
    if (!moorsteadBairnsSet) await loadModules();
  });

  it('sends daily_limit_min when limitMinutes is given', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 60, locked: false, closed: null },
    });
    await moorsteadBairnsSet({ limitMinutes: 60 });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.daily_limit_min, 60);
    assert.ok(!('locked' in body));
  });

  it('sends warn_sec when warnSeconds is given', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 0, warn_sec: 120, locked: false, closed: null },
    });
    await moorsteadBairnsSet({ warnSeconds: 120 });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.warn_sec, 120);
  });

  it('sends locked flag', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 0, warn_sec: 60, locked: true, closed: null },
    });
    await moorsteadBairnsSet({ locked: true });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.locked, true);
  });

  it('sends closed: {from, to} when closeFrom + closeTo given', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 60, locked: false, closed: { from: '20:00', to: '07:00' } },
    });
    await moorsteadBairnsSet({ closeFrom: '20:00', closeTo: '07:00' });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.closed, { from: '20:00', to: '07:00' });
  });

  it('sends closed: null when clearClosed is true', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 60, locked: false, closed: null },
    });
    await moorsteadBairnsSet({ clearClosed: true });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.closed, null);
  });

  it('sends multiple fields together', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 45, warn_sec: 300, locked: false, closed: { from: '21:00', to: '08:00' } },
    });
    await moorsteadBairnsSet({ limitMinutes: 45, warnSeconds: 300, closeFrom: '21:00', closeTo: '08:00' });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.daily_limit_min, 45);
    assert.equal(body.warn_sec, 300);
    assert.deepEqual(body.closed, { from: '21:00', to: '08:00' });
  });

  it('omits keys that were not provided', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 30, warn_sec: 60, locked: false, closed: null },
    });
    await moorsteadBairnsSet({ limitMinutes: 30 });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.ok(!('warn_sec' in body));
    assert.ok(!('locked' in body));
    assert.ok(!('closed' in body));
  });
});

describe('moorsteadBairnsSet — HH:MM validation', () => {
  beforeEach(async () => {
    if (!moorsteadBairnsSet) await loadModules();
  });

  it('rejects bad closeFrom without POSTing', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; };
    const result = await moorsteadBairnsSet({ closeFrom: 'nope', closeTo: '07:00' });
    assert.match(result, /Invalid closeFrom/);
    assert.match(result, /HH:MM/);
    assert.equal(fetched, false);
  });

  it('rejects bad closeTo without POSTing', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; };
    const result = await moorsteadBairnsSet({ closeFrom: '20:00', closeTo: '99:99:99' });
    assert.match(result, /Invalid closeTo/);
    assert.equal(fetched, false);
  });

  it('accepts single-digit hour (e.g. "7:00")', async () => {
    const getCapture = capturingFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 60, locked: false, closed: { from: '20:00', to: '7:00' } },
    });
    const result = await moorsteadBairnsSet({ closeFrom: '20:00', closeTo: '7:00' });
    const { opts } = getCapture();
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.closed, { from: '20:00', to: '7:00' });
    assert.doesNotMatch(result, /Invalid/);
  });
});

describe('moorsteadBairnsSet — confirmation output', () => {
  beforeEach(async () => {
    if (!moorsteadBairnsSet) await loadModules();
  });

  it('confirms the returned controls in the success message', async () => {
    mockFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 300, locked: false, closed: { from: '20:00', to: '07:00' } },
    });
    const result = await moorsteadBairnsSet({ limitMinutes: 60, closeFrom: '20:00', closeTo: '07:00' });
    assert.match(result, /Bairns world updated/);
    assert.match(result, /60 min/);
    assert.match(result, /closed 20:00–07:00/);
  });

  it('mentions "no closed window" when response returns closed: null', async () => {
    mockFetch(200, {
      controls: { daily_limit_min: 0, warn_sec: 60, locked: false, closed: null },
    });
    const result = await moorsteadBairnsSet({ clearClosed: true });
    assert.match(result, /no closed window/);
  });

  it('mentions "world locked" when returned controls has locked: true', async () => {
    mockFetch(200, {
      controls: { daily_limit_min: 60, warn_sec: 60, locked: true, closed: null },
    });
    const result = await moorsteadBairnsSet({ locked: true });
    assert.match(result, /world locked/);
  });
});

describe('moorsteadBairnsSet — error handling', () => {
  beforeEach(async () => {
    if (!moorsteadBairnsSet) await loadModules();
  });

  it('returns a clean error string on HTTP 401', async () => {
    mockFetch(401, 'Unauthorized');
    const result = await moorsteadBairnsSet({ limitMinutes: 60 });
    assert.match(result, /relay error 401/);
    assert.doesNotMatch(result, /throw|Error/);
  });

  it('returns a clean error string on network failure', async () => {
    mockFetchNetworkError('ETIMEDOUT');
    const result = await moorsteadBairnsSet({ limitMinutes: 60 });
    assert.match(result, /bairns set failed/);
    assert.match(result, /ETIMEDOUT/);
  });
});
