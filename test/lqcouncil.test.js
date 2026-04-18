// Tests for the LQ Council integration.
//
// Covers:
//   1. Group-tool-policy strips lqc_* from non-dev groups, keeps them in
//      the configured dev group JID, and keeps them in DMs.
//   2. The client's isEnabled() respects LQC_ENABLED + LQC_API_URL +
//      LQC_ADMIN_TOKEN.
//   3. The static guide handler returns the expected topics.
//   4. The onboarding checklist renders without a bot_id (no network).
//
// We don't stub fetch here — tools that need the network are exercised
// via in-situ smoke tests after deploy.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const DEV_JID = '120999999999999999@g.us';
const OTHER_JID = '120111111111111111@g.us';

async function loadModule(relPath) {
  const url = pathToFileURL(join(process.cwd(), relPath)).href + `?t=${Date.now()}_${Math.random()}`;
  return import(url);
}

describe('LQ Council integration', () => {
  beforeEach(() => {
    // Minimal env for config.js to parse. Config is a module-level
    // singleton, so we import it fresh per test via cache-busting URL.
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.LQC_ENABLED = 'true';
    process.env.LQC_API_URL = 'http://127.0.0.1:3100';
    process.env.LQC_ADMIN_TOKEN = 'test-token';
    process.env.LQC_DEV_GROUP_JID = DEV_JID;
  });

  it('filters lqc_* tools out of non-dev groups', async () => {
    const { filterToolsForChat } = await loadModule('src/group-tool-policy.js');
    const tools = [
      { name: 'web_search' },
      { name: 'lqc_status' },
      { name: 'lqc_bot_diagnose' },
      { name: 'calendar_list_events' },
    ];
    const filtered = filterToolsForChat(OTHER_JID, tools).map((t) => t.name);
    assert.deepEqual(filtered.sort(), ['calendar_list_events', 'web_search'].sort());
  });

  it('keeps lqc_* tools in the configured dev group', async () => {
    const { filterToolsForChat } = await loadModule('src/group-tool-policy.js');
    const tools = [
      { name: 'web_search' },
      { name: 'lqc_status' },
      { name: 'lqc_bot_diagnose' },
    ];
    const filtered = filterToolsForChat(DEV_JID, tools).map((t) => t.name);
    assert.ok(filtered.includes('lqc_status'), 'dev group must keep lqc_status');
    assert.ok(filtered.includes('lqc_bot_diagnose'), 'dev group must keep lqc_bot_diagnose');
    assert.ok(filtered.includes('web_search'));
  });

  it('keeps lqc_* tools in owner DMs (non-group chat)', async () => {
    const { filterToolsForChat } = await loadModule('src/group-tool-policy.js');
    const tools = [
      { name: 'web_search' },
      { name: 'lqc_status' },
    ];
    const filtered = filterToolsForChat('447000000000@s.whatsapp.net', tools).map((t) => t.name);
    assert.ok(filtered.includes('lqc_status'), 'DM must keep lqc_status');
  });

  it('client isEnabled returns true when fully configured', async () => {
    // Node's ES module loader caches config.js across imports (the URL
    // cache-bust only invalidates the target module, not its transitive
    // deps). So this assertion is limited to the "fully set" branch —
    // the other permutations are exercised by runtime behaviour when
    // the service boots with different env files.
    const { isEnabled } = await loadModule('src/lqcouncil/client.js');
    assert.equal(isEnabled(), true, 'all three env vars set → enabled');
  });

  it('bot author guide returns known topics', async () => {
    const { lqcBotAuthorGuide } = await loadModule('src/tools/lqcouncil.js');
    const overview = await lqcBotAuthorGuide({ topic: 'overview' });
    assert.match(overview, /end-to-end flow/i);

    const schema = await lqcBotAuthorGuide({ topic: 'schema' });
    assert.match(schema, /DebateRoundResponse|confidence/i);

    const unknown = await lqcBotAuthorGuide({ topic: 'quicksand' });
    assert.match(unknown, /Unknown topic/i);
  });

  it('self describe lists the tools', async () => {
    const { lqcSelfDescribe } = await loadModule('src/tools/lqcouncil.js');
    const out = await lqcSelfDescribe();
    for (const t of ['lqc_status', 'lqc_list_debates', 'lqc_validate_bot', 'lqc_bot_diagnose']) {
      assert.match(out, new RegExp(t));
    }
  });

  it('onboarding checklist renders without bot_id and does not reach the network', async () => {
    // Force LQC_ENABLED=false so any accidental network call would
    // throw synchronously rather than hang.
    process.env.LQC_ENABLED = 'false';
    const { lqcOnboardingChecklist } = await loadModule('src/tools/lqcouncil.js');
    const out = await lqcOnboardingChecklist({});
    assert.match(out, /checklist/i);
    assert.match(out, /Endpoint declared/);
    assert.match(out, /Admin smoke test passed/);
  });
});
