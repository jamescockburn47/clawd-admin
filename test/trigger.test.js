// test/trigger.test.js — Trigger module: shouldRespond logic for DMs, groups, mentions, prefixes
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
// Set group JID filter BEFORE config.js is imported (Object.freeze prevents later mutation)
const FILTERED_GROUP_JID = '120363009999999999@g.us';
process.env.WHATSAPP_GROUP_JID = FILTERED_GROUP_JID;

let shouldRespond;
let config;

const BOT_JID = '1234567890@s.whatsapp.net';
const BOT_LID = '1234567890@lid';
const OTHER_JID = '9999999999@s.whatsapp.net';
const GROUP_JID = '120363001234567890@g.us';

async function loadModules() {
  const mod = await import('../src/trigger.js');
  ({ shouldRespond } = mod);
  config = (await import('../src/config.js')).default;
}

function base(overrides = {}) {
  return {
    text: '',
    hasImage: false,
    isFromMe: false,
    isGroup: false,
    senderJid: OTHER_JID,
    botJid: BOT_JID,
    groupJid: FILTERED_GROUP_JID,
    mentionedJids: [],
    ...overrides,
  };
}

// ─── DM behaviour ───────────────────────────────────────────────

describe('DM behaviour', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('always responds to DMs', () => {
    const result = shouldRespond(base({ text: 'hello', isGroup: false }));
    assert.equal(result.respond, true);
    assert.equal(result.mode, 'direct');
  });

  it('secretaryMode true when text starts with clawdsec', () => {
    const result = shouldRespond(base({ text: 'clawdsec check my calendar', isGroup: false }));
    assert.equal(result.respond, true);
    assert.equal(result.secretaryMode, true);
  });

  it('secretaryMode false for normal DMs', () => {
    const result = shouldRespond(base({ text: 'what is the weather', isGroup: false }));
    assert.equal(result.respond, true);
    assert.equal(result.secretaryMode, false);
  });

  it('does not respond to own messages in DM', () => {
    const result = shouldRespond(base({ text: 'hello', isGroup: false, isFromMe: true }));
    assert.equal(result.respond, false);
  });

  it('responds to DM with image and no text', () => {
    const result = shouldRespond(base({ text: '', hasImage: true, isGroup: false }));
    assert.equal(result.respond, true);
  });
});

// ─── Group @mention ─────────────────────────────────────────────

describe('Group @mention', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('responds when botJid is in mentionedJids', () => {
    const result = shouldRespond(base({
      text: 'hey what do you think',
      isGroup: true,
      mentionedJids: [BOT_JID],
    }));
    assert.equal(result.respond, true);
    assert.equal(result.mode, 'direct');
  });

  it('responds when botLid is in mentionedJids', () => {
    globalThis._clawdBotLid = BOT_LID;
    const result = shouldRespond(base({
      text: 'hey what do you think',
      isGroup: true,
      mentionedJids: [BOT_LID],
    }));
    assert.equal(result.respond, true);
    assert.equal(result.mode, 'direct');
  });

  afterEach(() => { delete globalThis._clawdBotLid; });

  it('detects secretaryMode from text even when @mentioned', () => {
    const result = shouldRespond(base({
      text: 'clawdsec do something',
      isGroup: true,
      mentionedJids: [BOT_JID],
    }));
    assert.equal(result.respond, true);
    assert.equal(result.secretaryMode, true);
  });

  it('does NOT respond when unrelated JID is mentioned', () => {
    const result = shouldRespond(base({
      text: 'hey @someone else',
      isGroup: true,
      mentionedJids: ['5555555555@s.whatsapp.net'],
    }));
    assert.equal(result.respond, false);
  });
});

// ─── Group prefix commands ──────────────────────────────────────

describe('Group prefix commands', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('"clawd check my calendar" responds with mode direct, secretaryMode false', () => {
    const result = shouldRespond(base({
      text: 'clawd check my calendar',
      isGroup: true,
    }));
    assert.equal(result.respond, true);
    assert.equal(result.mode, 'direct');
    assert.equal(result.secretaryMode, false);
  });

  it('"clawdsec check my calendar" responds with mode direct, secretaryMode true', () => {
    const result = shouldRespond(base({
      text: 'clawdsec check my calendar',
      isGroup: true,
    }));
    assert.equal(result.respond, true);
    assert.equal(result.mode, 'direct');
    assert.equal(result.secretaryMode, true);
  });

  it('"clawdbot hello" responds with mode direct, secretaryMode false', () => {
    const result = shouldRespond(base({
      text: 'clawdbot hello',
      isGroup: true,
    }));
    assert.equal(result.respond, true);
    assert.equal(result.mode, 'direct');
    assert.equal(result.secretaryMode, false);
  });
});

// ─── Group name-in-text (passive mode removed) ─────────────────

describe('Group name-in-text (no passive mode)', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('"hey clawd what do you think" does NOT respond (no @mention or prefix)', () => {
    const result = shouldRespond(base({
      text: 'hey clawd what do you think',
      isGroup: true,
    }));
    assert.equal(result.respond, false);
  });

  it('"I was talking about clawd" does NOT respond', () => {
    const result = shouldRespond(base({
      text: 'I was talking about clawd',
      isGroup: true,
    }));
    assert.equal(result.respond, false);
  });

  it('"clawdsec" alone as text responds (exact match is a prefix command)', () => {
    const result = shouldRespond(base({
      text: 'clawdsec',
      isGroup: true,
    }));
    assert.equal(result.respond, true);
    assert.equal(result.secretaryMode, true);
  });
});

// ─── Own messages ───────────────────────────────────────────────

describe('Own messages', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('isFromMe true does not respond', () => {
    const result = shouldRespond(base({
      text: 'clawd hello',
      isGroup: true,
      isFromMe: true,
    }));
    assert.equal(result.respond, false);
  });

  it('senderJid === botJid does not respond', () => {
    const result = shouldRespond(base({
      text: 'clawd hello',
      isGroup: true,
      senderJid: BOT_JID,
    }));
    assert.equal(result.respond, false);
  });
});

// ─── Empty messages ─────────────────────────────────────────────

describe('Empty messages', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('no text, no image in group does not respond', () => {
    const result = shouldRespond(base({
      text: '',
      hasImage: false,
      isGroup: true,
    }));
    assert.equal(result.respond, false);
  });

  it('no text but has image in DM responds', () => {
    const result = shouldRespond(base({
      text: '',
      hasImage: true,
      isGroup: false,
    }));
    assert.equal(result.respond, true);
  });
});

// ─── Group JID filtering ────────────────────────────────────────

// Group JID filtering tests use FILTERED_GROUP_JID set via env before config import.
// config is frozen so we test match/mismatch by varying the groupJid argument.
describe('Group JID filtering', () => {
  beforeEach(async () => { if (!shouldRespond) await loadModules(); });

  it('does not respond when config.whatsappGroupJid is set and does not match', () => {
    // config.whatsappGroupJid === FILTERED_GROUP_JID, but we pass a different groupJid
    const result = shouldRespond(base({
      text: 'clawd hello',
      isGroup: true,
      groupJid: GROUP_JID, // different from FILTERED_GROUP_JID
    }));
    assert.equal(result.respond, false);
  });

  it('responds when config.whatsappGroupJid matches the group', () => {
    const result = shouldRespond(base({
      text: 'clawd hello',
      isGroup: true,
      groupJid: FILTERED_GROUP_JID, // matches config.whatsappGroupJid
    }));
    assert.equal(result.respond, true);
  });
});
