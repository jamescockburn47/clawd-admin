import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSkills,
  getActiveSkills,
  getSkillsForMessage,
  describeCapabilities,
  disableSkill,
  enableSkill,
} from '../../skill-registry.js';

describe('skill-registry', () => {
  beforeEach(async () => {
    await loadSkills();
  });

  it('discovers skills from src/skills/', async () => {
    const active = getActiveSkills();
    assert.ok(active.length > 0, 'Should discover at least the example skill');
    const names = active.map((s) => s.name);
    assert.ok(names.includes('example-skill'), 'Should include example-skill');
  });

  it('each skill has required contract fields', () => {
    const active = getActiveSkills();
    for (const skill of active) {
      assert.ok(skill.name, `Skill missing name`);
      assert.ok(skill.description, `${skill.name} missing description`);
      assert.equal(typeof skill.canHandle, 'function', `${skill.name} canHandle must be a function`);
      assert.equal(typeof skill.execute, 'function', `${skill.name} execute must be a function`);
      assert.ok(skill.selfExplanation, `${skill.name} missing selfExplanation`);
    }
  });

  it('getSkillsForMessage returns array', () => {
    const result = getSkillsForMessage({ text: 'hello' }, {});
    assert.ok(Array.isArray(result), 'Should return an array');
    // example-skill always returns false, so array should be empty
    assert.equal(result.length, 0, 'example-skill should not match');
  });

  it('describeCapabilities returns non-empty string', () => {
    const desc = describeCapabilities();
    assert.ok(typeof desc === 'string', 'Should return a string');
    assert.ok(desc.length > 0, 'Should be non-empty');
    assert.ok(desc.includes('example-skill'), 'Should mention example-skill');
  });

  it('disabled skills excluded from matching', () => {
    disableSkill('example-skill');
    const active = getActiveSkills();
    const names = active.map((s) => s.name);
    assert.ok(!names.includes('example-skill'), 'Disabled skill should be excluded');

    // Re-enable for subsequent tests
    enableSkill('example-skill');
    const reEnabled = getActiveSkills();
    assert.ok(
      reEnabled.map((s) => s.name).includes('example-skill'),
      'Re-enabled skill should be included'
    );
  });
});
