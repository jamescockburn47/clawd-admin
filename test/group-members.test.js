import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('group-members', () => {
  const REGISTER_PATH = join('data', 'runtime', 'group-members.json');
  const PENDING_DIR = join('data', 'runtime', 'pending-members');
  const GROUP_A = '120363000000000001@g.us';
  const GROUP_B = '120363000000000002@g.us';
  const HUMAN_JID = '447966523191@s.whatsapp.net';
  const BOT_JID = '447719697305@s.whatsapp.net';
  let originalContent;
  let members;

  beforeEach(async () => {
    if (existsSync(REGISTER_PATH)) {
      originalContent = readFileSync(REGISTER_PATH, 'utf-8');
    } else {
      originalContent = null;
    }
    writeFileSync(REGISTER_PATH, JSON.stringify({ groups: {} }, null, 2));
    if (existsSync(PENDING_DIR)) {
      rmSync(PENDING_DIR, { recursive: true, force: true });
    }

    const modulePath = join(process.cwd(), 'src', 'group-members.js');
    const moduleUrl = pathToFileURL(modulePath).href + `?t=${Date.now()}`;
    members = await import(moduleUrl);
    members.reloadGroupMembers();
  });

  afterEach(() => {
    if (originalContent !== null) {
      writeFileSync(REGISTER_PATH, originalContent);
    } else {
      writeFileSync(REGISTER_PATH, JSON.stringify({ groups: {} }, null, 2));
    }
    if (existsSync(PENDING_DIR)) {
      rmSync(PENDING_DIR, { recursive: true, force: true });
    }
  });

  describe('observeMember', () => {
    it('creates a new record on first sight with kind=unknown', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      const rec = members.getMember(GROUP_A, HUMAN_JID);
      assert.ok(rec);
      assert.equal(rec.canonicalName, 'James');
      assert.equal(rec.kind, 'unknown');
      assert.deepEqual(rec.aliases, []);
      assert.ok(rec.firstSeen);
      assert.equal(rec.firstSeen, rec.lastSeen);
    });

    it('seeds kind=bot-self when isBotSelf is true', () => {
      members.observeMember(GROUP_A, BOT_JID, 'Clint', { isBotSelf: true });
      const rec = members.getMember(GROUP_A, BOT_JID);
      assert.equal(rec.kind, 'bot-self');
    });

    it('promotes kind to bot-self on a later fromMe sighting', () => {
      members.observeMember(GROUP_A, BOT_JID, 'Clint');
      assert.equal(members.getMember(GROUP_A, BOT_JID).kind, 'unknown');
      members.observeMember(GROUP_A, BOT_JID, 'Clint', { isBotSelf: true });
      assert.equal(members.getMember(GROUP_A, BOT_JID).kind, 'bot-self');
    });

    it('updates lastSeen on repeat sighting', async () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      const first = members.getMember(GROUP_A, HUMAN_JID);
      await new Promise((r) => setTimeout(r, 10));
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      const second = members.getMember(GROUP_A, HUMAN_JID);
      assert.notEqual(first.lastSeen, second.lastSeen);
    });

    it('adds a new pushName to aliases when canonicalName differs', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      members.observeMember(GROUP_A, HUMAN_JID, 'James Cockburn');
      const rec = members.getMember(GROUP_A, HUMAN_JID);
      assert.equal(rec.canonicalName, 'James');
      assert.deepEqual(rec.aliases, ['James Cockburn']);
    });

    it('does not duplicate aliases', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      members.observeMember(GROUP_A, HUMAN_JID, 'James Cockburn');
      members.observeMember(GROUP_A, HUMAN_JID, 'James Cockburn');
      const rec = members.getMember(GROUP_A, HUMAN_JID);
      assert.deepEqual(rec.aliases, ['James Cockburn']);
    });

    it('ignores "Unknown" pushName at first sight', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'Unknown');
      const rec = members.getMember(GROUP_A, HUMAN_JID);
      // canonicalName falls back to the JID's local part, not the literal "Unknown"
      assert.equal(rec.canonicalName, '447966523191');
    });

    it('skips DM chat JIDs', () => {
      members.observeMember('447966523191@s.whatsapp.net', HUMAN_JID, 'James');
      assert.equal(members.getMember('447966523191@s.whatsapp.net', HUMAN_JID), null);
    });

    it('skips when senderJid is missing or invalid', () => {
      members.observeMember(GROUP_A, null, 'James');
      members.observeMember(GROUP_A, '', 'James');
      members.observeMember(GROUP_A, 'not-a-jid', 'James');
      assert.deepEqual(members.getMembers(GROUP_A), {});
    });

    it('keeps groups independent', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      members.observeMember(GROUP_B, HUMAN_JID, 'James');
      const a = members.getMember(GROUP_A, HUMAN_JID);
      const b = members.getMember(GROUP_B, HUMAN_JID);
      assert.ok(a);
      assert.ok(b);
      // Separate records with their own firstSeen
      assert.equal(Object.keys(members.getMembers(GROUP_A)).length, 1);
      assert.equal(Object.keys(members.getMembers(GROUP_B)).length, 1);
    });
  });

  describe('resolveSpeaker', () => {
    it('returns register record for known senders', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      const resolved = members.resolveSpeaker(GROUP_A, HUMAN_JID, 'James');
      assert.equal(resolved.source, 'register');
      assert.equal(resolved.canonicalName, 'James');
      assert.equal(resolved.kind, 'unknown');
    });

    it('quarantines unknown senders and falls back to pushName', () => {
      const resolved = members.resolveSpeaker(GROUP_A, HUMAN_JID, 'Stranger');
      assert.equal(resolved.source, 'quarantine');
      assert.equal(resolved.canonicalName, 'Stranger');
      // Quarantine file should now exist with one line
      const files = existsSync(PENDING_DIR) ? readdirSync(PENDING_DIR) : [];
      assert.equal(files.length, 1);
      const line = readFileSync(join(PENDING_DIR, files[0]), 'utf-8').trim();
      const parsed = JSON.parse(line);
      assert.equal(parsed.chatJid, GROUP_A);
      assert.equal(parsed.senderJid, HUMAN_JID);
      assert.equal(parsed.pushName, 'Stranger');
    });

    it('deduplicates quarantine writes within a process', () => {
      members.resolveSpeaker(GROUP_A, HUMAN_JID, 'Stranger');
      members.resolveSpeaker(GROUP_A, HUMAN_JID, 'Stranger');
      members.resolveSpeaker(GROUP_A, HUMAN_JID, 'Stranger');
      const files = readdirSync(PENDING_DIR);
      const contents = readFileSync(join(PENDING_DIR, files[0]), 'utf-8').trim();
      assert.equal(contents.split('\n').length, 1);
    });

    it('returns fallback source for invalid inputs', () => {
      const r1 = members.resolveSpeaker(null, HUMAN_JID, 'James');
      assert.equal(r1.source, 'fallback');
      assert.equal(r1.canonicalName, 'James');
      const r2 = members.resolveSpeaker(GROUP_A, '', 'James');
      assert.equal(r2.source, 'fallback');
    });

    it('falls back to JID local part when no pushName given', () => {
      const resolved = members.resolveSpeaker(GROUP_A, HUMAN_JID);
      assert.equal(resolved.canonicalName, '447966523191');
    });
  });

  describe('setMember', () => {
    it('promotes unknown to bot-other with operator link', () => {
      members.observeMember(GROUP_A, BOT_JID, 'Oscar');
      members.setMember(GROUP_A, BOT_JID, { kind: 'bot-other', operator: HUMAN_JID });
      const rec = members.getMember(GROUP_A, BOT_JID);
      assert.equal(rec.kind, 'bot-other');
      assert.equal(rec.operator, HUMAN_JID);
      assert.equal(rec.canonicalName, 'Oscar'); // preserved
    });

    it('creates a record when none exists', () => {
      members.setMember(GROUP_A, HUMAN_JID, { canonicalName: 'James', kind: 'human' });
      const rec = members.getMember(GROUP_A, HUMAN_JID);
      assert.equal(rec.canonicalName, 'James');
      assert.equal(rec.kind, 'human');
    });

    it('rejects invalid kind', () => {
      assert.throws(
        () => members.setMember(GROUP_A, HUMAN_JID, { kind: 'bogus' }),
        /invalid kind/,
      );
    });

    it('rejects missing chatJid or senderJid', () => {
      assert.throws(() => members.setMember(null, HUMAN_JID, { kind: 'human' }));
      assert.throws(() => members.setMember(GROUP_A, null, { kind: 'human' }));
    });

    it('persists to disk immediately', () => {
      members.setMember(GROUP_A, HUMAN_JID, { canonicalName: 'James', kind: 'human' });
      const raw = JSON.parse(readFileSync(REGISTER_PATH, 'utf-8'));
      assert.equal(raw.groups[GROUP_A][HUMAN_JID].kind, 'human');
    });
  });

  describe('getMembers / getMember', () => {
    it('returns a snapshot that does not mutate the register', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      const snap = members.getMembers(GROUP_A);
      snap[HUMAN_JID].canonicalName = 'Mutated';
      const rec = members.getMember(GROUP_A, HUMAN_JID);
      assert.equal(rec.canonicalName, 'James');
    });

    it('returns empty object for unknown group', () => {
      assert.deepEqual(members.getMembers(GROUP_A), {});
    });

    it('returns null for unknown member', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      assert.equal(members.getMember(GROUP_A, BOT_JID), null);
    });
  });

  describe('getMemberStats', () => {
    it('counts members by kind per group', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      members.observeMember(GROUP_A, BOT_JID, 'Clint', { isBotSelf: true });
      const stats = members.getMemberStats();
      assert.equal(stats[GROUP_A].total, 2);
      assert.equal(stats[GROUP_A].byKind['bot-self'], 1);
      assert.equal(stats[GROUP_A].byKind.unknown, 1);
    });
  });

  describe('flushGroupMembers', () => {
    it('writes pending observations to disk', () => {
      members.observeMember(GROUP_A, HUMAN_JID, 'James');
      members.flushGroupMembers();
      const raw = JSON.parse(readFileSync(REGISTER_PATH, 'utf-8'));
      assert.equal(raw.groups[GROUP_A][HUMAN_JID].canonicalName, 'James');
    });
  });
});
