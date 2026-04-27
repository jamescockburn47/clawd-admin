import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { createSchedulerTickRunner } = await import('../src/scheduler.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('scheduler overlap guard', () => {
  it('skips a tick when the previous scheduler run is still active', async () => {
    const started = deferred();
    const release = deferred();
    let tickRuns = 0;
    const warnLogs = [];

    const runner = createSchedulerTickRunner({
      runTick: async () => {
        tickRuns += 1;
        started.resolve();
        await release.promise;
      },
      logger: {
        warn: (fields, message) => warnLogs.push({ fields, message }),
      },
    });

    const firstTick = runner.run();
    await started.promise;

    const secondTick = await runner.run();
    release.resolve();
    const firstResult = await firstTick;

    assert.deepEqual(firstResult, { skipped: false });
    assert.deepEqual(secondTick, { skipped: true });
    assert.equal(tickRuns, 1);
    assert.equal(runner.getState().overlapSkips, 1);
    assert.equal(warnLogs.some((log) => log.message === 'scheduler tick skipped because previous tick is still running'), true);
  });
});
