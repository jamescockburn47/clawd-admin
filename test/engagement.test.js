// test/engagement.test.js — Engagement module: mute triggers, mute system, cooldowns, negative signals
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

let isMuteTrigger, activateMute, isMuted, clearMute;
let recordGroupResponse, isInCooldown;
let detectNegativeSignal, shouldEngage;

async function loadModules() {
  const mod = await import('../src/engagement.js');
  ({
    isMuteTrigger,
    activateMute,
    isMuted,
    clearMute,
    recordGroupResponse,
    isInCooldown,
    detectNegativeSignal,
    shouldEngage,
  } = mod);
}

// ── Mute triggers ─────────────────────────────────────────────────────────────

describe('isMuteTrigger', () => {
  beforeEach(async () => {
    if (!isMuteTrigger) await loadModules();
  });

  it('"clawd shut up" is a mute trigger', () => {
    assert.equal(isMuteTrigger('clawd shut up'), true);
  });

  it('"clawdbot be quiet" is a mute trigger', () => {
    assert.equal(isMuteTrigger('clawdbot be quiet'), true);
  });

  it('"clawdsec mute" is a mute trigger', () => {
    assert.equal(isMuteTrigger('clawdsec mute'), true);
  });

  it('"shut up" without bot name is not a trigger', () => {
    assert.equal(isMuteTrigger('shut up'), false);
  });

  it('"clawd" without mute keyword is not a trigger', () => {
    assert.equal(isMuteTrigger('clawd'), false);
  });

  it('null returns false', () => {
    assert.equal(isMuteTrigger(null), false);
  });

  it('empty string returns false', () => {
    assert.equal(isMuteTrigger(''), false);
  });
});

// ── Mute system ───────────────────────────────────────────────────────────────

describe('mute system (activateMute, isMuted, clearMute)', () => {
  const groupJid = 'test-group-mute@g.us';

  beforeEach(async () => {
    if (!activateMute) await loadModules();
    // Ensure clean state
    clearMute(groupJid);
  });

  it('isMuted returns false before any mute', () => {
    assert.equal(isMuted(groupJid), false);
  });

  it('isMuted returns true after activateMute', () => {
    activateMute(groupJid);
    assert.equal(isMuted(groupJid), true);
  });

  it('isMuted returns false after clearMute', () => {
    activateMute(groupJid);
    assert.equal(isMuted(groupJid), true);
    clearMute(groupJid);
    assert.equal(isMuted(groupJid), false);
  });
});

// ── Response cooldown ─────────────────────────────────────────────────────────

describe('response cooldown (recordGroupResponse, isInCooldown)', () => {
  const groupA = 'cooldown-group-a@g.us';
  const groupB = 'cooldown-group-b@g.us';

  beforeEach(async () => {
    if (!recordGroupResponse) await loadModules();
  });

  it('isInCooldown returns false before any response recorded', () => {
    const freshGroup = 'fresh-cooldown-group@g.us';
    assert.equal(isInCooldown(freshGroup), false);
  });

  it('isInCooldown returns true after recordGroupResponse', () => {
    recordGroupResponse(groupA);
    assert.equal(isInCooldown(groupA), true);
  });

  it('different group JIDs are independent', () => {
    recordGroupResponse(groupA);
    assert.equal(isInCooldown(groupA), true);
    assert.equal(isInCooldown(groupB), false);
  });
});

// ── Negative signal detection ─────────────────────────────────────────────────

describe('detectNegativeSignal', () => {
  beforeEach(async () => {
    if (!detectNegativeSignal) await loadModules();
  });

  it('"shut up clawd" detects told_off', () => {
    const result = detectNegativeSignal('shut up clawd');
    assert.notEqual(result, null);
    assert.equal(result.type, 'told_off');
  });

  it('"nobody asked you" detects told_off', () => {
    const result = detectNegativeSignal('nobody asked you');
    assert.notEqual(result, null);
    assert.equal(result.type, 'told_off');
  });

  it('"lol clawd" detects mocked', () => {
    const result = detectNegativeSignal('lol clawd');
    assert.notEqual(result, null);
    assert.equal(result.type, 'mocked');
  });

  it('"no clawd that\'s wrong" detects corrected', () => {
    const result = detectNegativeSignal("no clawd that's wrong");
    assert.notEqual(result, null);
    assert.equal(result.type, 'corrected');
  });

  it('"clawd is great" returns null (no negative signal)', () => {
    const result = detectNegativeSignal('clawd is great');
    assert.equal(result, null);
  });

  it('null returns null', () => {
    const result = detectNegativeSignal(null);
    assert.equal(result, null);
  });
});
