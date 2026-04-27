import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { londonDateString, triggerForgeNow } from '../forge-now-http.js';

describe('overnight/forge-now-http', () => {
  it('formats the run date in Europe/London', () => {
    const date = new Date('2026-04-27T21:30:00Z');
    assert.equal(londonDateString(date), '2026-04-27');
  });

  it('starts emergency IMPROVE and returns a 202 payload immediately', async () => {
    const calls: unknown[][] = [];
    const result = await triggerForgeNow({
      now: new Date('2026-04-27T18:45:00Z'),
      checkImprove: async (...args) => {
        calls.push(args);
      },
      logger: { error: () => {} },
    });

    assert.equal(result.status, 202);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.todayStr, '2026-04-27');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['2026-04-27', 22, 0, undefined, { emergencyMode: true }]);
  });

  it('logs asynchronous emergency IMPROVE failures without changing the accepted response', async () => {
    const errors: Array<{ fields: { err: string }; message: string }> = [];
    const result = await triggerForgeNow({
      now: new Date('2026-04-27T18:45:00Z'),
      checkImprove: async () => {
        throw new Error('forge failed later');
      },
      logger: {
        error: (fields, message) => errors.push({ fields, message }),
      },
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(result.status, 202);
    assert.equal(errors.length, 1);
    const firstError = errors[0];
    assert.ok(firstError);
    assert.equal(firstError.message, 'forge-now: emergency improve failed');
    assert.equal(firstError.fields.err, 'forge failed later');
  });
});
