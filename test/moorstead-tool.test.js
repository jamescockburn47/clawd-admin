// test/moorstead-tool.test.js — Moorstead admin tool handler tests
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// --- fetch mock infrastructure ---

let _fetchImpl = null;

function installFetchMock(impl) {
  globalThis.fetch = impl;
}

function restoreFetch() {
  delete globalThis.fetch;
}

// --- module load (dynamic import avoids top-level config parse without key) ---

let moorsteadStatus, moorsteadBroadcast, moorsteadKick;

async function loadModule() {
  if (moorsteadStatus) return;
  const mod = await import('../src/tools/moorstead.js');
  moorsteadStatus = mod.moorsteadStatus;
  moorsteadBroadcast = mod.moorsteadBroadcast;
  moorsteadKick = mod.moorsteadKick;
}

describe('moorstead admin tools', () => {
  beforeEach(async () => {
    await loadModule();
  });

  afterEach(() => {
    restoreFetch();
  });

  // --- moorstead_status ---

  describe('moorsteadStatus', () => {
    it('calls GET /admin/presence with Authorization header', async () => {
      let capturedUrl, capturedInit;
      installFetchMock(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          json: async () => ({ rooms: { moor: [{ pid: 'p1', name: 'Alice', x: 0, y: 0, z: 0 }] } }),
        };
      });

      await moorsteadStatus();

      assert.match(capturedUrl, /\/admin\/presence$/);
      assert.equal(capturedInit.method, 'GET');
      assert.match(capturedInit.headers['Authorization'], /^Bearer /);
    });

    it('formats multi-room presence correctly', async () => {
      installFetchMock(async () => ({
        ok: true,
        json: async () => ({
          rooms: {
            moor: [
              { pid: 'p1', name: 'Alice', x: 0, y: 0, z: 0 },
              { pid: 'p2', name: 'Tom', x: 1, y: 0, z: 0 },
            ],
            dale: [],
          },
        }),
      }));

      const result = await moorsteadStatus();

      assert.match(result, /\*Moorstead\*/);
      assert.match(result, /moor: Alice, Tom \(2\)/);
      assert.match(result, /dale: empty/);
    });

    it('returns no-active-rooms message when rooms is empty', async () => {
      installFetchMock(async () => ({
        ok: true,
        json: async () => ({ rooms: {} }),
      }));

      const result = await moorsteadStatus();
      assert.match(result, /no active rooms/);
    });

    it('returns clean error string on 401', async () => {
      installFetchMock(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized',
      }));

      const result = await moorsteadStatus();
      assert.match(result, /401/);
      assert.doesNotThrow(() => result); // is a string, not a throw
    });

    it('returns clean error string on network throw', async () => {
      installFetchMock(async () => {
        throw new Error('ECONNREFUSED');
      });

      const result = await moorsteadStatus();
      assert.match(result, /ECONNREFUSED/);
    });
  });

  // --- moorstead_broadcast ---

  describe('moorsteadBroadcast', () => {
    it('calls POST /admin/broadcast with correct URL and Authorization header', async () => {
      let capturedUrl, capturedInit;
      installFetchMock(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          json: async () => ({ ok: true, sent: 3 }),
        };
      });

      await moorsteadBroadcast({ text: 'Server restart in 5 minutes' });

      assert.match(capturedUrl, /\/admin\/broadcast$/);
      assert.equal(capturedInit.method, 'POST');
      assert.match(capturedInit.headers['Authorization'], /^Bearer /);
    });

    it('includes room in body when provided', async () => {
      let parsedBody;
      installFetchMock(async (url, init) => {
        parsedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, sent: 1 }) };
      });

      await moorsteadBroadcast({ text: 'Hello moor', room: 'moor' });

      assert.equal(parsedBody.room, 'moor');
      assert.equal(parsedBody.text, 'Hello moor');
    });

    it('formats successful broadcast result with sent count', async () => {
      installFetchMock(async () => ({
        ok: true,
        json: async () => ({ ok: true, sent: 5 }),
      }));

      const result = await moorsteadBroadcast({ text: 'Good morning' });
      assert.match(result, /5 player/);
    });

    it('formats result with room name when room specified', async () => {
      installFetchMock(async () => ({
        ok: true,
        json: async () => ({ ok: true, sent: 2 }),
      }));

      const result = await moorsteadBroadcast({ text: 'Watch out!', room: 'dale' });
      assert.match(result, /dale/);
    });

    it('returns clean error string on 401', async () => {
      installFetchMock(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized',
      }));

      const result = await moorsteadBroadcast({ text: 'test' });
      assert.match(result, /401/);
    });

    it('returns clean error string on network throw', async () => {
      installFetchMock(async () => { throw new Error('fetch failed'); });

      const result = await moorsteadBroadcast({ text: 'test' });
      assert.match(result, /fetch failed/);
    });

    it('returns error when text is empty', async () => {
      // no fetch installed — should short-circuit before calling
      const result = await moorsteadBroadcast({ text: '' });
      assert.match(result, /No message/);
    });
  });

  // --- moorstead_kick ---

  describe('moorsteadKick', () => {
    it('calls POST /admin/kick with correct URL and Authorization header', async () => {
      let capturedUrl, capturedInit;
      installFetchMock(async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          ok: true,
          json: async () => ({ ok: true, kicked: ['moor'] }),
        };
      });

      await moorsteadKick({ pid: 'player-123' });

      assert.match(capturedUrl, /\/admin\/kick$/);
      assert.equal(capturedInit.method, 'POST');
      assert.match(capturedInit.headers['Authorization'], /^Bearer /);
    });

    it('sends pid in request body', async () => {
      let parsedBody;
      installFetchMock(async (url, init) => {
        parsedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, kicked: ['moor'] }) };
      });

      await moorsteadKick({ pid: 'troublemaker-9' });
      assert.equal(parsedBody.pid, 'troublemaker-9');
    });

    it('formats kick result with room list', async () => {
      installFetchMock(async () => ({
        ok: true,
        json: async () => ({ ok: true, kicked: ['moor', 'dale'] }),
      }));

      const result = await moorsteadKick({ pid: 'griefer-7' });
      assert.match(result, /griefer-7/);
      assert.match(result, /moor/);
      assert.match(result, /dale/);
    });

    it('returns clean error string on 401', async () => {
      installFetchMock(async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized',
      }));

      const result = await moorsteadKick({ pid: 'p1' });
      assert.match(result, /401/);
    });

    it('returns clean error string on network throw', async () => {
      installFetchMock(async () => { throw new Error('network down'); });

      const result = await moorsteadKick({ pid: 'p1' });
      assert.match(result, /network down/);
    });

    it('returns error when pid is empty', async () => {
      const result = await moorsteadKick({ pid: '' });
      assert.match(result, /No pid/);
    });
  });
});
