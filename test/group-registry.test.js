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
    // Save original file
    if (existsSync(REGISTRY_PATH)) {
      originalContent = readFileSync(REGISTRY_PATH, 'utf-8');
    }

    // Write a test registry
    const testRegistry = {
      groups: {
        '120363001234567890@g.us': {
          label: 'Test Group Alpha',
          blockedTopics: ['Project X', 'Secret Initiative'],
          confidentialityPrompt: 'Do not discuss internal finances.',
        },
        '120363009999999999@g.us': {
          label: 'Open Group',
        },
        '120363005555555555@g.us': {
          label: 'Topics Only Group',
          blockedTopics: ['Learned Hand', 'Shlomo', 'Legal Quants'],
        },
      },
    };
    writeFileSync(REGISTRY_PATH, JSON.stringify(testRegistry, null, 2));

    // Dynamic import with file:// URL for Windows compat
    const modulePath = join(process.cwd(), 'src', 'group-registry.js');
    const moduleUrl = pathToFileURL(modulePath).href + `?t=${Date.now()}`;
    registry = await import(moduleUrl);
    registry.reloadGroupRegistry();
  });

  afterEach(() => {
    if (originalContent) {
      writeFileSync(REGISTRY_PATH, originalContent);
    } else {
      writeFileSync(REGISTRY_PATH, JSON.stringify({
        _comment: 'Group registry — maps WhatsApp group JIDs to labels and content restrictions.',
        groups: {},
      }, null, 2));
    }
  });

  describe('getGroupConfig', () => {
    it('returns config for a registered group', () => {
      const config = registry.getGroupConfig('120363001234567890@g.us');
      assert.ok(config);
      assert.equal(config.label, 'Test Group Alpha');
      assert.deepEqual(config.blockedTopics, ['Project X', 'Secret Initiative']);
    });

    it('returns null for an unregistered group', () => {
      const config = registry.getGroupConfig('999999999999@g.us');
      assert.equal(config, null);
    });

    it('returns null for null/undefined JID', () => {
      assert.equal(registry.getGroupConfig(null), null);
      assert.equal(registry.getGroupConfig(undefined), null);
      assert.equal(registry.getGroupConfig(''), null);
    });

    it('returns config without optional fields', () => {
      const config = registry.getGroupConfig('120363009999999999@g.us');
      assert.ok(config);
      assert.equal(config.label, 'Open Group');
      assert.equal(config.blockedTopics, undefined);
      assert.equal(config.confidentialityPrompt, undefined);
    });
  });

  describe('getGroupLabel', () => {
    it('returns label for registered group', () => {
      assert.equal(registry.getGroupLabel('120363001234567890@g.us'), 'Test Group Alpha');
    });

    it('returns null for unregistered group', () => {
      assert.equal(registry.getGroupLabel('999999999999@g.us'), null);
    });
  });

  describe('getGroupRestrictions', () => {
    it('returns combined restrictions for group with both topics and prompt', () => {
      const restrictions = registry.getGroupRestrictions('120363001234567890@g.us');
      assert.ok(restrictions.includes('Do not discuss internal finances.'));
      assert.ok(restrictions.includes('CONFIDENTIAL'));
      assert.ok(restrictions.includes('Project X'));
      assert.ok(restrictions.includes('Secret Initiative'));
    });

    it('returns only topic restrictions when no custom prompt', () => {
      const restrictions = registry.getGroupRestrictions('120363005555555555@g.us');
      assert.ok(restrictions.includes('Learned Hand'));
      assert.ok(restrictions.includes('Shlomo'));
      assert.ok(restrictions.includes('Legal Quants'));
      assert.ok(!restrictions.includes('Do not discuss internal'));
    });

    it('returns empty string for group with no restrictions', () => {
      assert.equal(registry.getGroupRestrictions('120363009999999999@g.us'), '');
    });

    it('returns empty string for unregistered group', () => {
      assert.equal(registry.getGroupRestrictions('999999999999@g.us'), '');
    });

    it('returns empty string for null JID', () => {
      assert.equal(registry.getGroupRestrictions(null), '');
    });

    it('starts with double newline when restrictions exist', () => {
      const restrictions = registry.getGroupRestrictions('120363001234567890@g.us');
      assert.ok(restrictions.startsWith('\n\n'));
    });

    it('includes refusal instruction in topic restrictions', () => {
      const restrictions = registry.getGroupRestrictions('120363005555555555@g.us');
      assert.ok(restrictions.includes('cannot discuss them'));
      assert.ok(restrictions.includes('Do not confirm or deny'));
    });
  });

  describe('getRegisteredGroups', () => {
    it('returns all registered groups with metadata', () => {
      const groups = registry.getRegisteredGroups();
      assert.equal(groups.length, 3);

      const alpha = groups.find(g => g.jid === '120363001234567890@g.us');
      assert.ok(alpha);
      assert.equal(alpha.label, 'Test Group Alpha');
      assert.deepEqual(alpha.blockedTopics, ['Project X', 'Secret Initiative']);
      assert.equal(alpha.hasConfidentialityPrompt, true);

      const open = groups.find(g => g.jid === '120363009999999999@g.us');
      assert.ok(open);
      assert.equal(open.label, 'Open Group');
      assert.deepEqual(open.blockedTopics, []);
      assert.equal(open.hasConfidentialityPrompt, false);
    });
  });

  describe('reloadGroupRegistry', () => {
    it('picks up changes after reload', () => {
      assert.ok(registry.getGroupConfig('120363001234567890@g.us'));

      writeFileSync(REGISTRY_PATH, JSON.stringify({
        groups: {
          '120363009999999999@g.us': { label: 'Only Group' },
        },
      }));

      registry.reloadGroupRegistry();

      assert.equal(registry.getGroupConfig('120363001234567890@g.us'), null);
      assert.equal(registry.getGroupLabel('120363009999999999@g.us'), 'Only Group');
    });
  });
});
