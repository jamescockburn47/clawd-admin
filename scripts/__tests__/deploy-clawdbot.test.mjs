import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(join(process.cwd(), 'scripts', 'deploy-clawdbot.sh'), 'utf8');

describe('deploy-clawdbot.sh', () => {
  it('refreshes system knowledge after a successful restart', () => {
    const restartIndex = script.indexOf('sudo systemctl restart "$UNIT"');
    const healthIndex = script.indexOf('checkEvoHealth');
    const refreshIndex = script.indexOf('refreshSystemKnowledge');

    assert.ok(restartIndex >= 0, 'script restarts the clawdbot unit');
    assert.ok(healthIndex >= 0, 'script checks EVO memory health first');
    assert.ok(refreshIndex >= 0, 'script refreshes system knowledge');
    assert.ok(healthIndex > restartIndex, 'health check runs after restart');
    assert.ok(refreshIndex > healthIndex, 'system knowledge refresh runs after EVO health check');
    assert.ok(refreshIndex > restartIndex, 'system knowledge refresh runs after restart');
    assert.match(script, /node --env-file=\.env/);
  });
});
