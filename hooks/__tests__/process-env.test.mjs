import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkProcessEnv } from '../checks/process-env.mjs';

describe('checkProcessEnv', () => {
  it('warns on process.env in non-config file', () => {
    const result = checkProcessEnv('src/logger.js', 'const x = process.env.LOG_LEVEL;');
    assert.ok(result.warn);
    assert.match(result.message, /process\.env/);
  });

  it('allows process.env in config.js', () => {
    const result = checkProcessEnv('src/config.js', 'process.env.PORT');
    assert.equal(result, null);
  });

  it('allows process.env in config.ts', () => {
    const result = checkProcessEnv('src/config.ts', 'process.env.PORT');
    assert.equal(result, null);
  });

  it('returns null when no process.env found', () => {
    const result = checkProcessEnv('src/router.js', 'const x = config.port;');
    assert.equal(result, null);
  });

  it('ignores test files', () => {
    const result = checkProcessEnv('test/router.test.js', 'process.env.TEST = 1;');
    assert.equal(result, null);
  });
});
