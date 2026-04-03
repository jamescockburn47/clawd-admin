# Forge Tester Prompt

Test generation guidelines for Forge-built skills. All tests use Node.js built-in test runner and assertion library. No external test frameworks.

## Framework

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
```

## Required Test Structure

Every skill test file MUST contain these sections in order:

### 1. canHandle Tests (minimum 12)

**6 positive tests** -- messages the skill MUST match:
```js
describe('canHandle - positive', () => {
  it('matches exact trigger phrase', () => {
    assert.strictEqual(skill.canHandle({ body: 'trigger phrase' }, ctx), true);
  });
  // ... 5 more
});
```

**6 negative tests** -- messages the skill MUST NOT match:
```js
describe('canHandle - negative', () => {
  it('rejects unrelated message', () => {
    assert.strictEqual(skill.canHandle({ body: 'something else' }, ctx), false);
  });
  it('rejects empty string', () => {
    assert.strictEqual(skill.canHandle({ body: '' }, ctx), false);
  });
  it('rejects null body', () => {
    assert.strictEqual(skill.canHandle({ body: null }, ctx), false);
  });
  // ... 3 more
});
```

Negative tests MUST include:
- Empty string
- Null/undefined body
- A message that is close but should not match (near-miss)
- A message that belongs to a different skill's scope

### 2. execute Tests (minimum 3)

**Output shape validation:**
```js
describe('execute', () => {
  it('returns expected shape', async () => {
    const result = await skill.execute({ body: 'valid input' }, ctx);
    assert.ok(result !== undefined);
    assert.ok(typeof result === 'string' || result === null);
  });

  it('returns null for bad input', async () => {
    const result = await skill.execute({ body: '' }, ctx);
    assert.strictEqual(result, null);
  });

  it('produces correct content', async () => {
    const result = await skill.execute({ body: 'specific input' }, ctx);
    assert.ok(result.includes('expected substring'));
  });
});
```

### 3. Integration Test (minimum 1)

```js
describe('integration', () => {
  it('skill appears in registry', async () => {
    // Import the registry and verify the skill is registered
    const registry = await import('../../src/skills/registry.js');
    const found = registry.getSkill('skill-name');
    assert.ok(found, 'Skill not found in registry');
    assert.strictEqual(typeof found.canHandle, 'function');
    assert.strictEqual(typeof found.execute, 'function');
  });
});
```

## Test Context Object

Provide a minimal but realistic context object for tests:

```js
const ctx = {
  jid: '447700000000@s.whatsapp.net',
  isOwner: true,
  isGroup: false,
  groupJid: null,
  pushName: 'TestUser',
  quotedMessage: null,
};
```

For group context tests, use:
```js
const groupCtx = {
  ...ctx,
  isGroup: true,
  groupJid: '120363000000@g.us',
};
```

## File Naming

Test files go in `tests/skills/` and are named `test-<skill-name>.js`:
```
tests/skills/test-unit-converter.js
tests/skills/test-dice-roller.js
```

## Rules

- No mocking frameworks. Use simple stub functions if needed.
- No network calls in tests. If the skill calls memory, stub the memory import.
- Tests must run in under 5 seconds total.
- Every assert must have a meaningful failure message or be self-documenting via the test name.
- Do not test implementation details. Test the public contract: canHandle and execute.
- If a skill has async execute, all execute tests must be async.
- Tests must be deterministic. No random inputs, no date-dependent assertions without freezing time.
