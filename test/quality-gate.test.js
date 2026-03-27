// test/quality-gate.test.js — Opus quality gate: shouldCritique logic and runCritique stripping
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let shouldCritique, runCritique;

async function loadModules() {
  const mod = await import('../src/quality-gate.js');
  ({ shouldCritique, runCritique } = mod);
}

describe('shouldCritique', () => {
  it('returns true for planning category with sufficient length', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('planning', 'x'.repeat(250), false), true);
  });

  it('returns true for legal category', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('legal', 'x'.repeat(250), false), true);
  });

  it('returns true for long email (>400 chars, >200 total)', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('email', 'x'.repeat(450), false), true);
  });

  it('returns false for short email (<400 chars)', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('email', 'x'.repeat(300), false), false);
  });

  it('returns false for conversational category', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('conversational', 'x'.repeat(500), false), false);
  });

  it('returns false for general_knowledge', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('general_knowledge', 'x'.repeat(500), false), false);
  });

  it('returns false when text is too short (<200 chars)', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('planning', 'short reply', false), false);
  });

  it('returns false when useClaudeClient is true (already Opus)', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('planning', 'x'.repeat(300), true), false);
  });

  it('returns false for soul confirmation responses', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('planning', 'Learned: new personality trait stored', false), false);
  });

  it('returns false for project update responses', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('planning', 'Updated the configuration for overnight mode' + 'x'.repeat(200), false), false);
  });

  it('returns false for mechanical "No pending" responses', async () => {
    if (!shouldCritique) await loadModules();
    assert.equal(shouldCritique('planning', 'No pending tasks in the queue right now' + 'x'.repeat(200), false), false);
  });
});

describe('runCritique — response processing', () => {
  // We test the stripping/processing logic by mocking the Anthropic client.
  // Since runCritique creates its client at module scope, we can't easily mock it.
  // Instead we test the observable behavior: the function should return original
  // text on failure (which is what happens when the client throws).

  it('returns original text when API call fails', async () => {
    if (!runCritique) await loadModules();
    // With a fake API key, the Anthropic client will throw
    const original = 'This is a perfectly good response that should survive critique failure.';
    const result = await runCritique(original, 'planning', () => {});
    assert.equal(result, original);
  });
});
