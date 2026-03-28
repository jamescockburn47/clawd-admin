import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

describe('group-registry', () => {
  const REGISTRY_PATH = join('data', 'group-registry.json');
  let originalContent;
  let registry;

  beforeEach(async () => {
    if (existsSync(REGISTRY_PATH)) {
      originalContent = readFileSync(REGISTRY_PATH, 'utf-8');
    }

    const testRegistry = {
      groups: {
        '120363001234567890@g.us': {
          label: 'Test Group Alpha',
          mode: 'colleague',
          blockedTopics: ['Project X', 'Secret Initiative'],
        },
        '120363009999999999@g.us': {
          label: 'Open Group',
          mode: 'open',
        },
        '120363005555555555@g.us': {
          label: 'Project Group',
          mode: 'project',
        },
      },
    };
    writeFileSync(REGISTRY_PATH, JSON.stringify(testRegistry, null, 2));

    const modulePath = join(process.cwd(), 'src', 'group-registry.js');
    const moduleUrl = pathToFileURL(modulePath).href + `?t=${Date.now()}`;
    registry = await import(moduleUrl);
    registry.reloadGroupRegistry();
  });

  afterEach(() => {
    if (originalContent) {
      writeFileSync(REGISTRY_PATH, originalContent);
    } else {
      writeFileSync(REGISTRY_PATH, JSON.stringify({ groups: {} }, null, 2));
    }
  });

  describe('getGroupConfig', () => {
    it('returns config for a registered group', () => {
      const config = registry.getGroupConfig('120363001234567890@g.us');
      assert.ok(config);
      assert.equal(config.label, 'Test Group Alpha');
      assert.equal(config.mode, 'colleague');
    });

    it('returns null for an unregistered group', () => {
      assert.equal(registry.getGroupConfig('999999999999@g.us'), null);
    });

    it('returns null for null/undefined JID', () => {
      assert.equal(registry.getGroupConfig(null), null);
      assert.equal(registry.getGroupConfig(undefined), null);
      assert.equal(registry.getGroupConfig(''), null);
    });
  });

  describe('getGroupMode', () => {
    it('returns configured mode for registered groups', () => {
      assert.equal(registry.getGroupMode('120363001234567890@g.us'), 'colleague');
      assert.equal(registry.getGroupMode('120363009999999999@g.us'), 'open');
      assert.equal(registry.getGroupMode('120363005555555555@g.us'), 'project');
    });

    it('returns colleague as default for unregistered group', () => {
      assert.equal(registry.getGroupMode('999999999999@g.us'), 'colleague');
    });
  });

  describe('getModeInfo', () => {
    it('returns mode metadata for valid modes', () => {
      const info = registry.getModeInfo('colleague');
      assert.ok(info.description.includes('side projects'));
      assert.ok(info.restrictions.length > 0);
    });

    it('returns colleague as fallback for invalid mode', () => {
      const info = registry.getModeInfo('nonexistent');
      assert.ok(info.description.includes('side projects'));
    });

    it('open mode has no restrictions', () => {
      const info = registry.getModeInfo('open');
      assert.equal(info.restrictions, '');
    });
  });

  describe('getGroupRestrictions', () => {
    it('returns empty string for open mode', () => {
      assert.equal(registry.getGroupRestrictions('120363009999999999@g.us'), '');
    });

    it('includes mode header and restrictions for project mode', () => {
      const restrictions = registry.getGroupRestrictions('120363005555555555@g.us');
      assert.ok(restrictions.includes('GROUP MODE: PROJECT'));
      assert.ok(restrictions.includes('personal life'));
    });

    it('includes mode restrictions and blocked topics for colleague mode', () => {
      const restrictions = registry.getGroupRestrictions('120363001234567890@g.us');
      assert.ok(restrictions.includes('GROUP MODE: COLLEAGUE'));
      assert.ok(restrictions.includes('side projects'));
      assert.ok(restrictions.includes('Project X'));
      assert.ok(restrictions.includes('Secret Initiative'));
      assert.ok(restrictions.includes('ADDITIONAL BLOCKED TOPICS'));
    });

    it('returns colleague restrictions for unregistered groups', () => {
      const restrictions = registry.getGroupRestrictions('999999999999@g.us');
      assert.ok(restrictions.includes('GROUP MODE: COLLEAGUE'));
    });

    it('starts with double newline when restrictions exist', () => {
      const restrictions = registry.getGroupRestrictions('120363005555555555@g.us');
      assert.ok(restrictions.startsWith('\n\n'));
    });
  });

  describe('getRegisteredGroups', () => {
    it('returns all registered groups with modes', () => {
      const groups = registry.getRegisteredGroups();
      assert.equal(groups.length, 3);

      const alpha = groups.find(g => g.jid === '120363001234567890@g.us');
      assert.ok(alpha);
      assert.equal(alpha.mode, 'colleague');
      assert.deepEqual(alpha.blockedTopics, ['Project X', 'Secret Initiative']);
    });
  });

  describe('findGroupByLabel', () => {
    it('finds group by partial label match', () => {
      const match = registry.findGroupByLabel('Alpha');
      assert.ok(match);
      assert.equal(match.jid, '120363001234567890@g.us');
    });

    it('case-insensitive search', () => {
      const match = registry.findGroupByLabel('open');
      assert.ok(match);
      assert.equal(match.jid, '120363009999999999@g.us');
    });

    it('returns null for no match', () => {
      assert.equal(registry.findGroupByLabel('Nonexistent'), null);
    });

    it('returns null for null/empty input', () => {
      assert.equal(registry.findGroupByLabel(null), null);
      assert.equal(registry.findGroupByLabel(''), null);
    });
  });

  describe('setGroupConfig', () => {
    it('creates new group config', () => {
      registry.setGroupConfig('120363008888888888@g.us', {
        label: 'New Group',
        mode: 'project',
      });
      const config = registry.getGroupConfig('120363008888888888@g.us');
      assert.equal(config.label, 'New Group');
      assert.equal(config.mode, 'project');
    });

    it('merges with existing config', () => {
      registry.setGroupConfig('120363001234567890@g.us', { mode: 'open' });
      const config = registry.getGroupConfig('120363001234567890@g.us');
      assert.equal(config.mode, 'open');
      assert.equal(config.label, 'Test Group Alpha'); // preserved
    });
  });

  describe('addBlockedTopics', () => {
    it('adds new topics', () => {
      const added = registry.addBlockedTopics('120363001234567890@g.us', ['New Topic']);
      assert.deepEqual(added, ['New Topic']);
      const config = registry.getGroupConfig('120363001234567890@g.us');
      assert.ok(config.blockedTopics.includes('New Topic'));
    });

    it('deduplicates existing topics (case-insensitive)', () => {
      const added = registry.addBlockedTopics('120363001234567890@g.us', ['project x']);
      assert.deepEqual(added, []);
    });

    it('adds to group without existing topics', () => {
      const added = registry.addBlockedTopics('120363009999999999@g.us', ['Sensitive']);
      assert.deepEqual(added, ['Sensitive']);
    });
  });

  describe('removeGroupConfig', () => {
    it('removes registered group', () => {
      assert.equal(registry.removeGroupConfig('120363001234567890@g.us'), true);
      assert.equal(registry.getGroupConfig('120363001234567890@g.us'), null);
    });

    it('returns false for unregistered group', () => {
      assert.equal(registry.removeGroupConfig('999999999999@g.us'), false);
    });
  });

  describe('getAllModes', () => {
    it('returns all 3 modes', () => {
      const modes = registry.getAllModes();
      assert.equal(modes.length, 3);
      const names = modes.map(m => m.name);
      assert.ok(names.includes('open'));
      assert.ok(names.includes('project'));
      assert.ok(names.includes('colleague'));
    });
  });

  describe('reloadGroupRegistry', () => {
    it('picks up changes after reload', () => {
      writeFileSync(REGISTRY_PATH, JSON.stringify({
        groups: { '120363009999999999@g.us': { label: 'Changed', mode: 'colleague' } },
      }));
      registry.reloadGroupRegistry();
      assert.equal(registry.getGroupMode('120363009999999999@g.us'), 'colleague');
      assert.equal(registry.getGroupConfig('120363001234567890@g.us'), null);
    });
  });
});
