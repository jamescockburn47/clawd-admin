import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('group tool policy', () => {
  const REGISTRY_PATH = join('data', 'runtime', 'group-registry.json');
  let originalRegistry;

  beforeEach(() => {
    if (existsSync(REGISTRY_PATH)) {
      originalRegistry = readFileSync(REGISTRY_PATH, 'utf-8');
    }
    writeFileSync(REGISTRY_PATH, JSON.stringify({
      groups: {
        '120363425230153097@g.us': {
          label: 'SOVREN',
          mode: 'project',
          allowedProjects: ['sovren'],
          projectScopeMode: 'single_project_only',
          offTopicPolicy: 'soft_redirect',
        },
        '120363409858920612@g.us': {
          label: 'LQcouncil',
          mode: 'project',
          allowedProjects: ['lqcouncil'],
          projectScopeMode: 'single_project_only',
          offTopicPolicy: 'soft_redirect',
        },
        '120363407496928531@g.us': {
          label: 'LQCore',
          mode: 'open',
        },
      },
    }, null, 2));
  });

  afterEach(() => {
    if (originalRegistry) {
      writeFileSync(REGISTRY_PATH, originalRegistry);
    }
  });

  it('filters SOVREN group tools down to non-personal tools', async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'group-tool-policy.js')).href + `?t=${Date.now()}`;
    const { filterToolsForChat } = await import(moduleUrl);
    const tools = [
      { name: 'web_search' },
      { name: 'project_read' },
      { name: 'sovren_site_access' },
      { name: 'calendar_list_events' },
      { name: 'todo_add' },
      { name: 'gmail_search' },
    ];
    const filtered = filterToolsForChat('120363425230153097@g.us', tools).map((tool) => tool.name);

    assert.deepEqual(filtered, ['web_search', 'project_read', 'sovren_site_access']);
  });

  it('keeps lqc_* tools in a group bound to the lqcouncil project', async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'group-tool-policy.js')).href + `?t=${Date.now()}`;
    const { filterToolsForChat } = await import(moduleUrl);
    const tools = [
      { name: 'web_search' },
      { name: 'lqc_onboarding_checklist' },
      { name: 'lqc_knowledge' },
      { name: 'lqc_status' },
      { name: 'memory_search' },
    ];
    const filtered = filterToolsForChat('120363409858920612@g.us', tools).map((tool) => tool.name);
    // All lqc_* tools must survive; nothing is stripped because this is
    // an LQcouncil-bound group (not SOVREN).
    assert.ok(filtered.includes('lqc_onboarding_checklist'));
    assert.ok(filtered.includes('lqc_knowledge'));
    assert.ok(filtered.includes('lqc_status'));
  });

  it('strips lqc_* tools in a non-LQcouncil-bound group (e.g. LQCore open mode)', async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'group-tool-policy.js')).href + `?t=${Date.now()}`;
    const { filterToolsForChat } = await import(moduleUrl);
    const tools = [
      { name: 'web_search' },
      { name: 'lqc_onboarding_checklist' },
      { name: 'lqc_knowledge' },
    ];
    const filtered = filterToolsForChat('120363407496928531@g.us', tools).map((tool) => tool.name);
    assert.ok(!filtered.includes('lqc_onboarding_checklist'));
    assert.ok(!filtered.includes('lqc_knowledge'));
    assert.ok(filtered.includes('web_search'));
  });
});
