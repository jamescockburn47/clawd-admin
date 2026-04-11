import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('project-access', () => {
  const GROUP_REGISTRY_PATH = join('data', 'runtime', 'group-registry.json');
  const PROJECTS_PATH = join('data', 'runtime', 'projects.json');
  let originalGroupRegistry;
  let originalProjects;

  beforeEach(() => {
    if (existsSync(GROUP_REGISTRY_PATH)) {
      originalGroupRegistry = readFileSync(GROUP_REGISTRY_PATH, 'utf-8');
    }
    if (existsSync(PROJECTS_PATH)) {
      originalProjects = readFileSync(PROJECTS_PATH, 'utf-8');
    }

    writeFileSync(GROUP_REGISTRY_PATH, JSON.stringify({
      groups: {
        '120363425230153097@g.us': {
          label: 'SOVREN',
          mode: 'project',
          allowedProjects: ['sovren'],
          projectScopeMode: 'single_project_only',
          offTopicPolicy: 'soft_redirect',
        },
      },
    }, null, 2));

    writeFileSync(PROJECTS_PATH, JSON.stringify({
      projects: [{
        id: 'sovren',
        name: 'SOVREN — Sovereign Award Valuation Engine',
        status: 'active',
        oneLiner: 'Deterministic valuation platform for arbitration awards.',
        summary: 'A deterministic platform for valuing arbitration awards against sovereign and corporate debtors.',
        foundingInsight: 'Zero AI in the valuation chain; AI only assists extraction.',
        keyDifferentiators: [
          'Zero AI in valuation calculations',
          'Human validation gateway',
        ],
        architecture: {
          layers: [
            { name: 'Extraction and Validation', description: 'Hybrid regex plus local LLM extraction.' },
            { name: 'Deterministic Valuation Engine', description: 'Auditable formula-based valuation.' },
          ],
        },
        nextSteps: [
          'Expand precedent corpus',
          'Maintain sovereign parameter governance',
        ],
        tags: ['sovren', 'arbitration', 'valuation'],
        evoPath: '~/projects/sovren',
        localPath: 'C:\\Users\\James\\Desktop\\Projects\\SOVREN',
      }],
    }, null, 2));
  });

  afterEach(() => {
    if (originalGroupRegistry) {
      writeFileSync(GROUP_REGISTRY_PATH, originalGroupRegistry);
    }
    if (originalProjects) {
      writeFileSync(PROJECTS_PATH, originalProjects);
    }
  });

  it('builds a rich project-scoped prompt for Sovren', async () => {
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'project-access.js')).href + `?t=${Date.now()}`;
    const { buildProjectScopePrompt } = await import(moduleUrl);
    const fragment = buildProjectScopePrompt(
      '120363425230153097@g.us',
      '[Current message]\nTell me what you know about SOVREN',
    );

    assert.match(fragment, /PROJECT ACCESS POLICY/);
    assert.match(fragment, /SOVREN — Sovereign Award Valuation Engine/);
    assert.match(fragment, /Founding insight:/i);
    assert.match(fragment, /Key differentiators:/i);
    assert.match(fragment, /Architecture layers:/i);
    assert.match(fragment, /Next steps:/i);
    assert.match(fragment, /single_project_only/);
  });
});
