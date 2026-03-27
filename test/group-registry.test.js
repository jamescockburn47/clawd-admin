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
          securityLevel: 7,
          blockedTopics: ['Project X', 'Secret Initiative'],
        },
        '120363009999999999@g.us': {
          label: 'Open Group',
          securityLevel: 1,
        },
        '120363005555555555@g.us': {
          label: 'Standard Group',
          securityLevel: 3,
        },
        '120363006666666666@g.us': {
          label: 'Lockdown Group',
          securityLevel: 10,
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
      assert.equal(config.securityLevel, 7);
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

  describe('getSecurityLevel', () => {
    it('returns configured level for registered group', () => {
      assert.equal(registry.getSecurityLevel('120363001234567890@g.us'), 7);
      assert.equal(registry.getSecurityLevel('120363009999999999@g.us'), 1);
      assert.equal(registry.getSecurityLevel('120363006666666666@g.us'), 10);
    });

    it('returns default level 3 for unregistered group', () => {
      assert.equal(registry.getSecurityLevel('999999999999@g.us'), 3);
    });
  });

  describe('getSecurityLevelInfo', () => {
    it('returns level metadata', () => {
      const info = registry.getSecurityLevelInfo(7);
      assert.equal(info.name, 'Confidential');
      assert.ok(info.restrictions.length > 0);
    });

    it('returns level 5 as fallback for invalid levels', () => {
      const info = registry.getSecurityLevelInfo(99);
      assert.equal(info.name, 'Guarded');
    });
  });

  describe('getGroupRestrictions', () => {
    it('returns empty string for level 1', () => {
      assert.equal(registry.getGroupRestrictions('120363009999999999@g.us'), '');
    });

    it('includes security level header and restrictions', () => {
      const restrictions = registry.getGroupRestrictions('120363005555555555@g.us');
      assert.ok(restrictions.includes('SECURITY LEVEL 3'));
      assert.ok(restrictions.includes('STANDARD'));
      assert.ok(restrictions.includes('personal life'));
    });

    it('includes both level restrictions and blocked topics', () => {
      const restrictions = registry.getGroupRestrictions('120363001234567890@g.us');
      assert.ok(restrictions.includes('SECURITY LEVEL 7'));
      assert.ok(restrictions.includes('CONFIDENTIAL'));
      assert.ok(restrictions.includes('Project X'));
      assert.ok(restrictions.includes('Secret Initiative'));
      assert.ok(restrictions.includes('ADDITIONAL BLOCKED TOPICS'));
    });

    it('returns level 3 restrictions for unregistered groups', () => {
      const restrictions = registry.getGroupRestrictions('999999999999@g.us');
      assert.ok(restrictions.includes('SECURITY LEVEL 3'));
    });

    it('returns heavy restrictions for level 10', () => {
      const restrictions = registry.getGroupRestrictions('120363006666666666@g.us');
      assert.ok(restrictions.includes('SECURITY LEVEL 10'));
      assert.ok(restrictions.includes('MAXIMUM'));
    });

    it('starts with double newline when restrictions exist', () => {
      const restrictions = registry.getGroupRestrictions('120363005555555555@g.us');
      assert.ok(restrictions.startsWith('\n\n'));
    });

    it('returns empty string for null JID at default level', () => {
      // null JID → getGroupConfig returns null → securityLevel defaults to 3
      const restrictions = registry.getGroupRestrictions(null);
      assert.ok(restrictions.includes('SECURITY LEVEL 3'));
    });
  });

  describe('getRegisteredGroups', () => {
    it('returns all registered groups with security levels', () => {
      const groups = registry.getRegisteredGroups();
      assert.equal(groups.length, 4);

      const alpha = groups.find(g => g.jid === '120363001234567890@g.us');
      assert.ok(alpha);
      assert.equal(alpha.securityLevel, 7);
      assert.deepEqual(alpha.blockedTopics, ['Project X', 'Secret Initiative']);
    });
  });

  describe('setGroupConfig', () => {
    it('creates new group config', () => {
      registry.setGroupConfig('120363008888888888@g.us', {
        label: 'New Group',
        securityLevel: 5,
      });
      const config = registry.getGroupConfig('120363008888888888@g.us');
      assert.equal(config.label, 'New Group');
      assert.equal(config.securityLevel, 5);
    });

    it('merges with existing config', () => {
      registry.setGroupConfig('120363001234567890@g.us', { securityLevel: 9 });
      const config = registry.getGroupConfig('120363001234567890@g.us');
      assert.equal(config.securityLevel, 9);
      assert.equal(config.label, 'Test Group Alpha'); // preserved
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

  describe('getAllSecurityLevels', () => {
    it('returns all 10 levels', () => {
      const levels = registry.getAllSecurityLevels();
      assert.equal(levels.length, 10);
      assert.equal(levels[0].level, 1);
      assert.equal(levels[0].name, 'Open');
      assert.equal(levels[9].level, 10);
      assert.equal(levels[9].name, 'Maximum');
    });
  });

  describe('reloadGroupRegistry', () => {
    it('picks up changes after reload', () => {
      writeFileSync(REGISTRY_PATH, JSON.stringify({
        groups: { '120363009999999999@g.us': { label: 'Changed', securityLevel: 8 } },
      }));
      registry.reloadGroupRegistry();
      assert.equal(registry.getSecurityLevel('120363009999999999@g.us'), 8);
      assert.equal(registry.getGroupConfig('120363001234567890@g.us'), null);
    });
  });
});
