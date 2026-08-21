// Set environment before any imports
process.env.ANTHROPIC_API_KEY = 'test-placeholder';

import { test, describe, expect } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test/mock';

// Mock dependencies
const mockEvoLlm = {
  classifyViaEvo: mock.fn(),
};

// Mock buffer module
const mockBuffer = {
  getRecentMessages: mock.fn(),
};

// Mock logger
const mockLogger = {
  info: mock.fn(),
  warn: mock.fn(),
};

// Mock config
const mockConfig = {
  engagementClassifierEnabled: true,
  groupMuteDurationMs: 300000,
};

// Mock constants
const mockConstants = {
  DEFAULT_MESSAGE_COUNT: 10,
};

// Import the module under test
const mod = await import('../src/engagement.js');

// Set up mocks
const { classifyViaEvo } = mockEvoLlm;
const { getRecentMessages } = mockBuffer;
const { info, warn } = mockLogger;
const { engagementClassifierEnabled, groupMuteDurationMs } = mockConfig;

// Mock the config module
const mockConfigModule = {
  default: mockConfig,
};
const mockConstantsModule = {
  DEFAULT_MESSAGE_COUNT: mockConstants.DEFAULT_MESSAGE_COUNT,
};

// Mock evo-llm.js
const evoLlmModule = {
  classifyViaEvo: mockEvoLlm.classifyViaEvo,
};

// Mock buffer.js
const bufferModule = {
  getRecentMessages: mockBuffer.getRecentMessages,
};

// Mock logger.js
const loggerModule = {
  default: mockLogger,
};

// Mock config.js
const configModule = {
  default: mockConfig,
};

// Mock constants.js
const constantsModule = {
  DEFAULT_MESSAGE_COUNT: mockConstants.DEFAULT_MESSAGE_COUNT,
};

// Mock evo-llm.js
const evoLlmPath = '../src/evo-llm.js';
const bufferPath = '../src/buffer.js';
const loggerPath = '../src/logger.js';
const configPath = '../src/config.js';
const constantsPath = '../src/constants.js';

// Mock dynamic imports
const originalImport = globalThis.import;
globalThis.import = async (path) => {
  if (path === evoLlmPath) return evoLlmModule;
  if (path === bufferPath) return bufferModule;
  if (path === loggerPath) return loggerModule;
  if (path === configPath) return configModule;
  if (path === constantsPath) return constantsModule;
  return originalImport(path);
};

// Restore original import after tests
afterEach(() => {
  globalThis.import = originalImport;
});

describe('engagement.js', () => {
  describe('isMuteTrigger', () => {
    it('returns false for empty text', () => {
      assert.strictEqual(mod.isMuteTrigger(''), false);
    });

    it('returns false for text without bot name', () => {
      assert.strictEqual(mod.isMuteTrigger('shut up'), false);
    });

    it('returns false for text without mute keyword', () => {
      assert.strictEqual(mod.isMuteTrigger('clawd'), false);
    });

    it('returns true for text with both bot name and mute keyword', () => {
      assert.strictEqual(mod.isMuteTrigger('clawd shut up'), true);
    });

    it('returns true for case-insensitive matches', () => {
      assert.strictEqual(mod.isMuteTrigger('CLAWD SHUT UP'), true);
    });

    it('returns true for text with multiple spaces', () => {
      assert.strictEqual(mod.isMuteTrigger('clawd   shut up'), true);
    });
  });

  describe('activateMute', () => {
    it('sets mute expiration for a group', () => {
      const groupJid = '1234567890@g.us';
      const now = Date.now();
      const expires = now + groupMuteDurationMs;

      mod.activateMute(groupJid);

      const expiresAt = mod.mutes.get(groupJid);
      assert.strictEqual(expiresAt, expires);
      assert.strictEqual(info.mock.calls.length, 1);
      assert.strictEqual(info.mock.calls[0][0].groupJid, groupJid);
      assert.strictEqual(info.mock.calls[0][0].durationMs, groupMuteDurationMs);
    });
  });

  describe('isMuted', () => {
    it('returns false for non-existent group', () => {
      const groupJid = '1234567890@g.us';
      assert.strictEqual(mod.isMuted(groupJid), false);
    });

    it('returns false for expired mute', () => {
      const groupJid = '1234567890@g.us';
      const now = Date.now();
      const expires = now - 1000;
      mod.mutes.set(groupJid, expires);

      assert.strictEqual(mod.isMuted(groupJid), false);
      assert.strictEqual(mod.mutes.get(groupJid), undefined);
    });

    it('returns true for active mute', () => {
      const groupJid = '1234567890@g.us';
      const now = Date.now();
      const expires = now + 1000;
      mod.mutes.set(groupJid, expires);

      assert.strictEqual(mod.isMuted(groupJid), true);
    });
  });

  describe('clearMute', () => {
    it('removes mute for a group', () => {
      const groupJid = '1234567890@g.us';
      mod.mutes.set(groupJid, Date.now() + 1000);

      mod.clearMute(groupJid);

      assert.strictEqual(mod.mutes.get(groupJid), undefined);
      assert.strictEqual(info.mock.calls.length, 1);
      assert.strictEqual(info.mock.calls[0][0].groupJid, groupJid);
    });
  });

  describe('recordGroupResponse', () => {
    it('records response time for a group', () => {
      const groupJid = '1234567890@g.us';
      const now = Date.now();

      mod.recordGroupResponse(groupJid);

      assert.strictEqual(mod.lastResponseTime.get(groupJid), now);
    });
  });

  describe('isInCooldown', () => {
    it('returns false for non-existent group', () => {
      const groupJid = '1234567890@g.us';
      assert.strictEqual(mod.isInCooldown(groupJid), false);
    });

    it('returns false for group with response time outside cooldown', () => {
      const groupJid = '1234567890@g.us';
      const now = Date.now();
      mod.lastResponseTime.set(groupJid, now - 120001);

      assert.strictEqual(mod.isInCooldown(groupJid), false);
      assert.strictEqual(mod.lastResponseTime.get(groupJid), undefined);
    });

    it('returns true for group within cooldown', () => {
      const groupJid = '1234567890@g.us';
      const now = Date.now();
      mod.lastResponseTime.set(groupJid, now - 1000);

      assert.strictEqual(mod.isInCooldown(groupJid), true);
    });
  });

  describe('detectNegativeSignal', () => {
    it('returns null for empty text', () => {
      assert.strictEqual(mod.detectNegativeSignal(''), null);
    });

    it('returns null for text without negative patterns', () => {
      assert.strictEqual(mod.detectNegativeSignal('Hello'), null);
    });

    it('detects "told_off" pattern', () => {
      const result = mod.detectNegativeSignal('clawd shut up');
      assert.strictEqual(result.type, 'told_off');
      assert.strictEqual(result.matched, 'shut up');
    });

    it('detects "mocked" pattern', () => {
      const result = mod.detectNegativeSignal('clawd lol');
      assert.strictEqual(result.type, 'mocked');
      assert.strictEqual(result.matched, 'lol');
    });

    it('detects "corrected" pattern', () => {
      const result = mod.detectNegativeSignal('no clawd');
      assert.strictEqual(result.type, 'corrected');
      assert.strictEqual(result.matched, 'no clawd');
    });

    it('detects case-insensitive patterns', () => {
      const result = mod.detectNegativeSignal('CLAWD NO');
      assert.strictEqual(result.type, 'corrected');
      assert.strictEqual(result.matched, 'NO');
    });

    it('returns null for text with multiple patterns but no match', () => {
      assert.strictEqual(mod.detectNegativeSignal('clawd nice'), null);
    });
  });

  describe('shouldEngage', () => {
    it('returns true when classifier is disabled', async () => {
      mockConfig.engagementClassifierEnabled = false;
      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'Hello');
      assert.strictEqual(result, true);
    });

    it('returns false when classifier returns null', async () => {
      classifyViaEvo.mockResolvedValue(null);
      getRecentMessages.mockReturnValue([]);

      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'Hello');
      assert.strictEqual(result, false);
      assert.strictEqual(warn.mock.calls.length, 1);
      assert.strictEqual(warn.mock.calls[0][0].err, 'engagement classifier returned null — defaulting to silent');
    });

    it('returns true when classifier returns "yes"', async () => {
      classifyViaEvo.mockResolvedValue('yes');
      getRecentMessages.mockReturnValue([]);

      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'Hello');
      assert.strictEqual(result, true);
      assert.strictEqual(info.mock.calls.length, 1);
      assert.strictEqual(info.mock.calls[0][0].groupJid, '1234567890@g.us');
      assert.strictEqual(info.mock.calls[0][0].senderName, 'John');
      assert.strictEqual(info.mock.calls[0][0].result, 'yes');
      assert.strictEqual(info.mock.calls[0][0].engage, true);
    });

    it('returns false when classifier returns "no"', async () => {
      classifyViaEvo.mockResolvedValue('no');
      getRecentMessages.mockReturnValue([]);

      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'Hello');
      assert.strictEqual(result, false);
      assert.strictEqual(info.mock.calls.length, 1);
      assert.strictEqual(info.mock.calls[0][0].groupJid, '1234567890@g.us');
      assert.strictEqual(info.mock.calls[0][0].senderName, 'John');
      assert.strictEqual(info.mock.calls[0][0].result, 'no');
      assert.strictEqual(info.mock.calls[0][0].engage, false);
    });

    it('falls back to keyword detection on classifier error', async () => {
      classifyViaEvo.mockRejectedValue(new Error('Network error'));
      getRecentMessages.mockReturnValue([]);

      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'Hello');
      assert.strictEqual(result, false);
      assert.strictEqual(warn.mock.calls.length, 1);
      assert.strictEqual(warn.mock.calls[0][0].err, 'engagement classifier failed — using keyword fallback');
    });

    it('returns true when keyword fallback detects a valid message', async () => {
      classifyViaEvo.mockRejectedValue(new Error('Network error'));
      getRecentMessages.mockReturnValue([]);

      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'clawd help');
      assert.strictEqual(result, true);
    });

    it('returns false when keyword fallback detects an invalid message', async () => {
      classifyViaEvo.mockRejectedValue(new Error('Network error'));
      getRecentMessages.mockReturnValue([]);

      const result = await mod.shouldEngage('1234567890@g.us', 'John', 'hello');
      assert.strictEqual(result, false);
    });
  });

  describe('keywordFallback', () => {
    it('returns false for empty text', () => {
      assert.strictEqual(mod.keywordFallback(''), false);
    });

    it('returns false for text without bot name', () => {
      assert.strictEqual(mod.keywordFallback('help'), false);
    });

    it('returns false for text without question or help request', () => {
      assert.strictEqual(mod.keywordFallback('clawd hello'), false);
    });

    it('returns true for text with bot name and question', () => {
      assert.strictEqual(mod.keywordFallback('clawd what is this?'), true);
    });

    it('returns true for text with bot name and help request', () => {
      assert.strictEqual(mod.keywordFallback('clawd can you help?'), true);
    });

    it('returns false for text with bot name and short message', () => {
      assert.strictEqual(mod.keywordFallback('clawd ok'), false);
    });
  });
});
