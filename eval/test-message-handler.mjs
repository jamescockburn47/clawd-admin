// test-message-handler.mjs
process.env.ANTHROPIC_API_KEY = 'test-placeholder';

import { test, describe, expect } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { mock } from 'node:test';
import { readFile } from 'node:fs/promises';

// Set up test environment
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock dependencies
const mockBuffer = {
  pushMessage: mock.fn(),
  buildContext: mock.fn(),
  botRecentlySpokeIn: mock.fn(),
  getRecentMessages: mock.fn(),
  getAllRecentMessages: mock.fn(),
  saveBuffers: mock.fn(),
  loadBuffers: mock.fn(),
  flushBufferTimer: mock.fn(),
};

const mockClaude = {
  getClawdResponse: mock.fn(),
  getGroupModeResponse: mock.fn(),
  getLastToolsCalled: mock.fn(),
};

const mockInteractionLog = {
  logInteraction: mock.fn(),
  handleReaction: mock.fn(),
  isCorrection: mock.fn(),
  logFeedback: mock.fn(),
  getRecentInteractions: mock.fn(),
  getRecentFeedback: mock.fn(),
  getQualitySummary: mock.fn(),
};

const mockEngagement = {
  isMuteTrigger: mock.fn(),
  activateMute: mock.fn(),
  isMuted: mock.fn(),
  clearMute: mock.fn(),
  recordGroupResponse: mock.fn(),
  isInCooldown: mock.fn(),
  detectNegativeSignal: mock.fn(),
  shouldEngage: mock.fn(),
};

const mockLquorumRag = {
  scanMessage: mock.fn(),
};

const mockMemory = {
  logConversation: mock.fn(),
};

const mockDocumentHandler = {
  getDocumentInfo: mock.fn(),
  processDocument: mock.fn(),
};

const mockEvolutionGate = {
  handleEvolutionConfirmation: mock.fn(),
  handleEvolutionApproval: mock.fn(),
};

const mockMessageCache = {
  cacheSentMessage: mock.fn(),
  getCachedMessage: mock.fn(),
};

const mockSessionRepair = {
  recordDecryptionFailure: mock.fn(),
};

const mockOutputFilter = {
  filterResponse: mock.fn(),
  getBlockedResponse: mock.fn(),
  getCanaryToken: mock.fn(),
  resetCanaryToken: mock.fn(),
};

const mockGroupModes = {
  detectGroupModeExit: mock.fn(),
  detectGroupMode: mock.fn(),
  detectTopicSelection: mock.fn(),
  runTopicRetrieval: mock.fn(),
  executeGroupMode: mock.fn(),
  buildExecutionPrompt: mock.fn(),
};

const mockPendingAction = {
  clearPendingAction: mock.fn(),
  getPendingAction: mock.fn(),
  setPendingAction: mock.fn(),
  parseTopicSelection: mock.fn(),
};

const mockSse = {
  addSSEClient: mock.fn(),
  getSSEClientCount: mock.fn(),
  broadcastSSE: mock.fn(),
};

const mockTrigger = {
  shouldRespond: mock.fn(),
};

const mockVoiceHandler = {
  handleVoiceLocal: mock.fn(),
  handleVoiceCommand: mock.fn(),
  handleDashboardChat: mock.fn(),
};

const mockWidgets = {
  getWidgetData: mock.fn(),
  forceRefresh: mock.fn(),
  startWidgetRefresh: mock.fn(),
  stopWidgetRefresh: mock.fn(),
};

// Mock config
const mockConfig = {
  ownerJid: 'owner@example.com',
  ownerLid: 'owner@example.com',
  triggerPrefix: 'clawd',
  engagementClassifierEnabled: true,
  evoMemoryEnabled: true,
};

// Mock logger
const mockLogger = {
  debug: mock.fn(),
  info: mock.fn(),
  warn: mock.fn(),
  error: mock.fn(),
};

// Mock file system
const mockFs = {
  readFile: mock.fn(),
};

// Mock other modules
const mockModules = {
  '@whiskeysockets/baileys': {
    downloadMediaMessage: mock.fn(),
  },
  './config.js': mockConfig,
  './logger.js': mockLogger,
  './trigger.js': mockTrigger,
  './buffer.js': mockBuffer,
  './claude.js': mockClaude,
  './sse.js': mockSse,
  './interaction-log.js': mockInteractionLog,
  './engagement.js': mockEngagement,
  './lquorum-rag.js': mockLquorumRag,
  './memory.js': mockMemory,
  './document-handler.js': mockDocumentHandler,
  './evolution-gate.js': mockEvolutionGate,
  './message-cache.js': mockMessageCache,
  './session-repair.js': mockSessionRepair,
  './output-filter.js': mockOutputFilter,
  './group-modes.js': mockGroupModes,
  './pending-action.js': mockPendingAction,
  './voice-handler.js': mockVoiceHandler,
  './widgets.js': mockWidgets,
};

// Import the module under test
const mod = await import('../src/message-handler.js');

// Test setup
const mockSock = {
  sendMessage: mock.fn(),
  sendPresenceUpdate: mock.fn(),
  presenceSubscribe: mock.fn(),
  key: { remoteJid: 'group@example.com' },
};
const mockMessage = {
  key: { id: 'msg123', remoteJid: 'group@example.com', participant: 'user@example.com' },
  message: {
    conversation: 'Hello',
    imageMessage: { mimetype: 'image/jpeg' },
    videoMessage: { caption: 'video' },
    documentMessage: { caption: 'document' },
    extendedTextMessage: { contextInfo: { participant: 'bot@example.com' } },
  },
  pushName: 'User',
  messageStubType: 0,
};
const mockBotJid = 'bot@example.com';

// Helper functions
function createMockMessage(text = '', hasImage = false, docInfo = null) {
  const msg = {
    key: { id: 'msg123', remoteJid: 'group@example.com', participant: 'user@example.com' },
    message: {
      conversation: text,
    },
    pushName: 'User',
    messageStubType: 0,
  };

  if (hasImage) {
    msg.message.imageMessage = { mimetype: 'image/jpeg' };
  }

  if (docInfo) {
    msg.message.documentMessage = { caption: docInfo.fileName };
  }

  return msg;
}

// Tests
describe('message-handler.js', () => {
  beforeEach(() => {
    // Reset mocks
    mockBuffer.pushMessage.mockReset();
    mockBuffer.buildContext.mockReset();
    mockBuffer.botRecentlySpokeIn.mockReset();
    mockBuffer.getRecentMessages.mockReset();
    mockBuffer.getAllRecentMessages.mockReset();
    mockBuffer.saveBuffers.mockReset();
    mockBuffer.loadBuffers.mockReset();
    mockBuffer.flushBufferTimer.mockReset();

    mockClaude.getClawdResponse.mockReset();
    mockClaude.getGroupModeResponse.mockReset();
    mockClaude.getLastToolsCalled.mockReset();

    mockInteractionLog.logInteraction.mockReset();
    mockInteractionLog.handleReaction.mockReset();
    mockInteractionLog.isCorrection.mockReset();
    mockInteractionLog.logFeedback.mockReset();
    mockInteractionLog.getRecentInteractions.mockReset();
    mockInteractionLog.getRecentFeedback.mockReset();
    mockInteractionLog.getQualitySummary.mockReset();

    mockEngagement.isMuteTrigger.mockReset();
    mockEngagement.activateMute.mockReset();
    mockEngagement.isMuted.mockReset();
    mockEngagement.clearMute.mockReset();
    mockEngagement.recordGroupResponse.mockReset();
    mockEngagement.isInCooldown.mockReset();
    mockEngagement.detectNegativeSignal.mockReset();
    mockEngagement.shouldEngage.mockReset();

    mockLquorumRag.scanMessage.mockReset();

    mockMemory.logConversation.mockReset();

    mockDocumentHandler.getDocumentInfo.mockReset();
    mockDocumentHandler.processDocument.mockReset();

    mockEvolutionGate.handleEvolutionConfirmation.mockReset();
    mockEvolutionGate.handleEvolutionApproval.mockReset();

    mockMessageCache.cacheSentMessage.mockReset();
    mockMessageCache.getCachedMessage.mockReset();

    mockSessionRepair.recordDecryptionFailure.mockReset();

    mockOutputFilter.filterResponse.mockReset();
    mockOutputFilter.getBlockedResponse.mockReset();
    mockOutputFilter.getCanaryToken.mockReset();
    mockOutputFilter.resetCanaryToken.mockReset();

    mockGroupModes.detectGroupModeExit.mockReset();
    mockGroupModes.detectGroupMode.mockReset();
    mockGroupModes.detectTopicSelection.mockReset();
    mockGroupModes.runTopicRetrieval.mockReset();
    mockGroupModes.executeGroupMode.mockReset();
    mockGroupModes.buildExecutionPrompt.mockReset();

    mockPendingAction.clearPendingAction.mockReset();
    mockPendingAction.getPendingAction.mockReset();
    mockPendingAction.setPendingAction.mockReset();
    mockPendingAction.parseTopicSelection.mockReset();

    mockSse.addSSEClient.mockReset();
    mockSse.getSSEClientCount.mockReset();
    mockSse.broadcastSSE.mockReset();

    mockTrigger.shouldRespond.mockReset();

    mockVoiceHandler.handleVoiceLocal.mockReset();
    mockVoiceHandler.handleVoiceCommand.mockReset();
    mockVoiceHandler.handleDashboardChat.mockReset();

    mockWidgets.getWidgetData.mockReset();
    mockWidgets.forceRefresh.mockReset();
    mockWidgets.startWidgetRefresh.mockReset();
    mockWidgets.stopWidgetRefresh.mockReset();

    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();

    mockFs.readFile.mockReset();

    // Reset global state
    const recentMessageIds = new Set();
    const lastImageByChat = new Map();
    const lastDocByChat = new Map();
  });

  describe('isOwnerJid', () => {
    test('returns true for owner JID', () => {
      const result = mod.isOwnerJid('owner@example.com');
      assert.strictEqual(result, true);
    });

    test('returns false for non-owner JID', () => {
      const result = mod.isOwnerJid('user@example.com');
      assert.strictEqual(result, false);
    });

    test('returns true when no owner configured', () => {
      const originalConfig = { ...mockConfig };
      mockConfig.ownerJid = undefined;
      mockConfig.ownerLid = undefined;
      const result = mod.isOwnerJid('user@example.com');
      assert.strictEqual(result, true);
      // Restore
      mockConfig.ownerJid = originalConfig.ownerJid;
      mockConfig.ownerLid = originalConfig.ownerLid;
    });
  });

  describe('isOwnerChat', () => {
    test('returns true for owner chat', () => {
      const result = mod.isOwnerChat('owner@example.com');
      assert.strictEqual(result, true);
    });

    test('returns false for non-owner chat', () => {
      const result = mod.isOwnerChat('user@example.com');
      assert.strictEqual(result, false);
    });
  });

  describe('extractText', () => {
    test('extracts conversation text', () => {
      const msg = { message: { conversation: 'Hello' } };
      const result = mod.extractText(msg);
      assert.strictEqual(result, 'Hello');
    });

    test('extracts extended text message text', () => {
      const msg = { message: { extendedTextMessage: { text: 'Hello' } } };
      const result = mod.extractText(msg);
      assert.strictEqual(result, 'Hello');
    });

    test('extracts image caption', () => {
      const msg = { message: { imageMessage: { caption: 'Hello' } } };
      const result = mod.extractText(msg);
      assert.strictEqual(result, 'Hello');
    });

    test('extracts video caption', () => {
      const msg = { message: { videoMessage: { caption: 'Hello' } } };
      const result = mod.extractText(msg);
      assert.strictEqual(result, 'Hello');
    });

    test('extracts document caption', () => {
      const msg = { message: { documentMessage: { caption: 'Hello' } } };
      const result = mod.extractText(msg);
      assert.strictEqual(result, 'Hello');
    });

    test('returns empty string for no text', () => {
      const msg = { message: {} };
      const result = mod.extractText(msg);
      assert.strictEqual(result, '');
    });

    test('handles complex message structure', () => {
      const msg = {
        message: {
          documentWithCaptionMessage: {
            message: { documentMessage: { caption: 'Hello' } },
          },
        },
      };
      const result = mod.extractText(msg);
      assert.strictEqual(result, 'Hello');
    });
  });

  describe('splitMessage', () => {
    test('splits message into single chunk when under limit', () => {
      const result = mod.splitMessage('Hello'.repeat(100));
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], 'Hello'.repeat(100));
    });

    test('splits message into multiple chunks when over limit', () => {
      const text = 'Hello'.repeat(500);
      const result = mod.splitMessage(text);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].length, 3000);
      assert.strictEqual(result[1].length, 2000);
    });

    test('splits at newline when possible', () => {
      const text = 'Hello\n\nWorld';
      const result = mod.splitMessage(text);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0], 'Hello');
      assert.strictEqual(result[1], 'World');
    });

    test('splits at space when newline not available', () => {
      const text = 'Hello world this is a long message that exceeds the limit';
      const result = mod.splitMessage(text);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].endsWith('world'), true);
      assert.strictEqual(result[1].startsWith('this'), true);
    });

    test('handles empty text', () => {
      const result = mod.splitMessage('');
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], '');
    });

    test('handles null text', () => {
      const result = mod.splitMessage(null);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], '');
    });

    test('handles undefined text', () => {
      const result = mod.splitMessage(undefined);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], '');
    });
  });

  describe('simulateTyping', () => {
    test('sends presence updates with proper timing', async () => {
      const sock = {
        sendPresenceUpdate: mock.fn(),
        presenceSubscribe: mock.fn(),
      };

      await mod.simulateTyping(sock, 'chat@example.com', 1000);

      assert.strictEqual(sock.presenceSubscribe.mock.calls.length, 1);
      assert.strictEqual(sock.sendPresenceUpdate.mock.calls.length, 2);
      assert.strictEqual(sock.sendPresenceUpdate.mock.calls[0].arguments[0], 'composing');
      assert.strictEqual(sock.sendPresenceUpdate.mock.calls[1].arguments[0], 'paused');
      assert.strictEqual(sock.sendPresenceUpdate.mock.calls[1].arguments[1], 'chat@example.com');
    });

    test('handles errors gracefully', async () => {
      const sock = {
        sendPresenceUpdate: mock.fn().mockRejectedValue(new Error('test error')),
        presenceSubscribe: mock.fn().mockRejectedValue(new Error('test error')),
      };

      await mod.simulateTyping(sock, 'chat@example.com', 1000);

      assert.strictEqual(sock.presenceSubscribe.mock.calls.length, 1);
      assert.strictEqual(sock.sendPresenceUpdate.mock.calls.length, 2);
    });
  });

  describe('handleIncomingMessage', () => {
    test('handles decryption failure', async () => {
      const message = {
        key: { remoteJid: 'user@example.com' },
        messageStubType: 2,
      };

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockSessionRepair.recordDecryptionFailure.mock.calls.length, 1);
      assert.strictEqual(mockSessionRepair.recordDecryptionFailure.mock.calls[0].arguments[0], 'user@example.com');
    });

    test('skips duplicate messages', async () => {
      // Set up duplicate detection
      const message = { key: { id: 'msg123' } };
      mockBuffer.pushMessage.mockImplementation(() => {});

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockBuffer.pushMessage.mock.calls.length, 1);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[0], 'msg123');
    });

    test('handles evolution confirmation', async () => {
      const message = { key: { id: 'msg123' } };
      mockEvolutionGate.handleEvolutionConfirmation.mockResolvedValue(true);

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockEvolutionGate.handleEvolutionConfirmation.mock.calls.length, 1);
      assert.strictEqual(mockEvolutionGate.handleEvolutionConfirmation.mock.calls[0].arguments[0], mockSock);
      assert.strictEqual(mockEvolutionGate.handleEvolutionConfirmation.mock.calls[0].arguments[1], 'msg123');
    });

    test('handles evolution approval', async () => {
      const message = { key: { id: 'msg123' } };
      mockEvolutionGate.handleEvolutionApproval.mockResolvedValue(true);

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockEvolutionGate.handleEvolutionApproval.mock.calls.length, 1);
      assert.strictEqual(mockEvolutionGate.handleEvolutionApproval.mock.calls[0].arguments[0], mockSock);
      assert.strictEqual(mockEvolutionGate.handleEvolutionApproval.mock.calls[0].arguments[1], 'msg123');
    });

    test('handles group message with scan', async () => {
      const message = { key: { id: 'msg123' }, message: { conversation: 'Hello' } };
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'direct' });
      mockLquorumRag.scanMessage.mockReturnValue('scan result');

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockLquorumRag.scanMessage.mock.calls.length, 1);
      assert.strictEqual(mockLquorumRag.scanMessage.mock.calls[0].arguments[0], 'Hello');
    });

    test('handles direct response with image', async () => {
      const message = createMockMessage('Hello', true);
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'direct' });
      mockBuffer.buildContext.mockReturnValue('context');
      mockClaude.getClawdResponse.mockResolvedValue('response');
      mockBuffer.pushMessage.mockImplementation(() => {});
      mockSse.broadcastSSE.mockImplementation(() => {});
      mockLogger.info.mockImplementation(() => {});
      mockLogger.debug.mockImplementation(() => {});
      mockLogger.warn.mockImplementation(() => {});
      mockLogger.error.mockImplementation(() => {});
      mockFs.readFile.mockResolvedValue('image data');
      mockVoiceHandler.handleVoiceLocal.mockImplementation(() => {});
      mockVoiceHandler.handleVoiceCommand.mockImplementation(() => {});
      mockVoiceHandler.handleDashboardChat.mockImplementation(() => {});
      mockWidgets.getWidgetData.mockImplementation(() => {});
      mockWidgets.forceRefresh.mockImplementation(() => {});
      mockWidgets.startWidgetRefresh.mockImplementation(() => {});
      mockWidgets.stopWidgetRefresh.mockImplementation(() => {});

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockBuffer.buildContext.mock.calls.length, 1);
      assert.strictEqual(mockBuffer.buildContext.mock.calls[0].arguments[0], 'msg123');
      assert.strictEqual(mockClaude.getClawdResponse.mock.calls.length, 1);
      assert.strictEqual(mockClaude.getClawdResponse.mock.calls[0].arguments[0], 'context');
      assert.strictEqual(mockClaude.getClawdResponse.mock.calls[0].arguments[1], 'direct');
      assert.strictEqual(mockClaude.getClawdResponse.mock.calls[0].arguments[2], 'user@example.com');
      assert.strictEqual(mockClaude.getClawdResponse.mock.calls[0].arguments[3], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'image data' } });
      assert.strictEqual(mockClaude.getClawdResponse.mock.calls[0].arguments[4], 'msg123');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls.length, 1);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[0], 'msg123');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].senderName, 'User');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].text, 'Hello');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].hasImage, true);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].isBot, false);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls.length, 1);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[0], 'message');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].sender, 'User');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].text, 'Hello');
      assert.strictEqual(mockLogger.info.mock.calls.length, 1);
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].mode, 'direct');
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].chat, 'msg123');
      assert.strictEqual(mockLogger.debug.mock.calls.length, 1);
      assert.strictEqual(mockLogger.debug.mock.calls[0].arguments[0].msgId, 'msg123');
      assert.strictEqual(mockLogger.warn.mock.calls.length, 0);
      assert.strictEqual(mockLogger.error.mock.calls.length, 0);
      assert.strictEqual(mockFs.readFile.mock.calls.length, 1);
      assert.strictEqual(mockFs.readFile.mock.calls[0].arguments[0], 'image data');
      assert.strictEqual(mockVoiceHandler.handleVoiceLocal.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleVoiceCommand.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleDashboardChat.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.getWidgetData.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.forceRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.startWidgetRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.stopWidgetRefresh.mock.calls.length, 1);
    });

    test('handles document processing', async () => {
      const message = createMockMessage('Hello', false, { fileName: 'test.pdf' });
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'direct' });
      mockBuffer.buildContext.mockReturnValue('context');
      mockClaude.getClawdResponse.mockResolvedValue('response');
      mockDocumentHandler.getDocumentInfo.mockReturnValue({ fileName: 'test.pdf' });
      mockDocumentHandler.processDocument.mockResolvedValue({ messageText: 'processed text' });
      mockBuffer.pushMessage.mockImplementation(() => {});
      mockSse.broadcastSSE.mockImplementation(() => {});
      mockLogger.info.mockImplementation(() => {});
      mockLogger.debug.mockImplementation(() => {});
      mockLogger.warn.mockImplementation(() => {});
      mockLogger.error.mockImplementation(() => {});
      mockFs.readFile.mockResolvedValue('image data');
      mockVoiceHandler.handleVoiceLocal.mockImplementation(() => {});
      mockVoiceHandler.handleVoiceCommand.mockImplementation(() => {});
      mockVoiceHandler.handleDashboardChat.mockImplementation(() => {});
      mockWidgets.getWidgetData.mockImplementation(() => {});
      mockWidgets.forceRefresh.mockImplementation(() => {});
      mockWidgets.startWidgetRefresh.mockImplementation(() => {});
      mockWidgets.stopWidgetRefresh.mockImplementation(() => {});

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockDocumentHandler.getDocumentInfo.mock.calls.length, 1);
      assert.strictEqual(mockDocumentHandler.getDocumentInfo.mock.calls[0].arguments[0], message);
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls.length, 1);
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls[0].arguments[0], 'buffer');
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls[0].arguments[1], { fileName: 'test.pdf' });
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls[0].arguments[2], 'Hello');
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls[0].arguments[3], 'User');
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls[0].arguments[4], 'msg123');
      assert.strictEqual(mockDocumentHandler.processDocument.mock.calls[0].arguments[5], lastDocByChat);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls.length, 1);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[0], 'msg123');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].senderName, 'User');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].text, 'processed text');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].hasImage, false);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].isBot, false);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls.length, 1);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[0], 'message');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].sender, 'User');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].text, 'processed text');
      assert.strictEqual(mockLogger.info.mock.calls.length, 1);
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].mode, 'direct');
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].chat, 'msg123');
      assert.strictEqual(mockLogger.debug.mock.calls.length, 1);
      assert.strictEqual(mockLogger.debug.mock.calls[0].arguments[0].msgId, 'msg123');
      assert.strictEqual(mockLogger.warn.mock.calls.length, 0);
      assert.strictEqual(mockLogger.error.mock.calls.length, 0);
      assert.strictEqual(mockFs.readFile.mock.calls.length, 1);
      assert.strictEqual(mockFs.readFile.mock.calls[0].arguments[0], 'image data');
      assert.strictEqual(mockVoiceHandler.handleVoiceLocal.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleVoiceCommand.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleDashboardChat.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.getWidgetData.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.forceRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.startWidgetRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.stopWidgetRefresh.mock.calls.length, 1);
    });

    test('handles correction feedback', async () => {
      const message = createMockMessage('Hello');
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'direct' });
      mockBuffer.buildContext.mockReturnValue('context');
      mockClaude.getClawdResponse.mockResolvedValue('response');
      mockBuffer.pushMessage.mockImplementation(() => {});
      mockSse.broadcastSSE.mockImplementation(() => {});
      mockLogger.info.mockImplementation(() => {});
      mockLogger.debug.mockImplementation(() => {});
      mockLogger.warn.mockImplementation(() => {});
      mockLogger.error.mockImplementation(() => {});
      mockFs.readFile.mockResolvedValue('image data');
      mockVoiceHandler.handleVoiceLocal.mockImplementation(() => {});
      mockVoiceHandler.handleVoiceCommand.mockImplementation(() => {});
      mockVoiceHandler.handleDashboardChat.mockImplementation(() => {});
      mockWidgets.getWidgetData.mockImplementation(() => {});
      mockWidgets.forceRefresh.mockImplementation(() => {});
      mockWidgets.startWidgetRefresh.mockImplementation(() => {});
      mockWidgets.stopWidgetRefresh.mockImplementation(() => {});
      mockInteractionLog.isCorrection.mockReturnValue(true);
      mockInteractionLog.logFeedback.mockImplementation(() => {});

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockInteractionLog.isCorrection.mock.calls.length, 1);
      assert.strictEqual(mockInteractionLog.isCorrection.mock.calls[0].arguments[0], 'Hello');
      assert.strictEqual(mockInteractionLog.logFeedback.mock.calls.length, 1);
      assert.strictEqual(mockInteractionLog.logFeedback.mock.calls[0].arguments[0].type, 'correction');
      assert.strictEqual(mockInteractionLog.logFeedback.mock.calls[0].arguments[0].signal, 'negative');
      assert.strictEqual(mockInteractionLog.logFeedback.mock.calls[0].arguments[0].detail, 'Hello');
      assert.strictEqual(mockInteractionLog.logFeedback.mock.calls[0].arguments[0].sender.name, 'User');
      assert.strictEqual(mockInteractionLog.logFeedback.mock.calls[0].arguments[0].sender.jid, 'user@example.com');
    });

    test('handles image caption', async () => {
      const message = createMockMessage('', true);
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'direct' });
      mockBuffer.buildContext.mockReturnValue('context');
      mockClaude.getClawdResponse.mockResolvedValue('response');
      mockBuffer.pushMessage.mockImplementation(() => {});
      mockSse.broadcastSSE.mockImplementation(() => {});
      mockLogger.info.mockImplementation(() => {});
      mockLogger.debug.mockImplementation(() => {});
      mockLogger.warn.mockImplementation(() => {});
      mockLogger.error.mockImplementation(() => {});
      mockFs.readFile.mockResolvedValue('image data');
      mockVoiceHandler.handleVoiceLocal.mockImplementation(() => {});
      mockVoiceHandler.handleVoiceCommand.mockImplementation(() => {});
      mockVoiceHandler.handleDashboardChat.mockImplementation(() => {});
      mockWidgets.getWidgetData.mockImplementation(() => {});
      mockWidgets.forceRefresh.mockImplementation(() => {});
      mockWidgets.startWidgetRefresh.mockImplementation(() => {});
      mockWidgets.stopWidgetRefresh.mockImplementation(() => {});

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockBuffer.pushMessage.mock.calls.length, 1);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[0], 'msg123');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].senderName, 'User');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].text, '[Photo shared — respond naturally as part of the conversation. React to what you see, relate it to the discussion if relevant. Do not just label or identify objects.]');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].hasImage, true);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].isBot, false);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls.length, 1);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[0], 'message');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].sender, 'User');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].text, '[Photo shared — respond naturally as part of the conversation. React to what you see, relate it to the discussion if relevant. Do not just label or identify objects.]');
      assert.strictEqual(mockLogger.info.mock.calls.length, 1);
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].mode, 'direct');
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].chat, 'msg123');
      assert.strictEqual(mockLogger.debug.mock.calls.length, 1);
      assert.strictEqual(mockLogger.debug.mock.calls[0].arguments[0].msgId, 'msg123');
      assert.strictEqual(mockLogger.warn.mock.calls.length, 0);
      assert.strictEqual(mockLogger.error.mock.calls.length, 0);
      assert.strictEqual(mockFs.readFile.mock.calls.length, 1);
      assert.strictEqual(mockFs.readFile.mock.calls[0].arguments[0], 'image data');
      assert.strictEqual(mockVoiceHandler.handleVoiceLocal.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleVoiceCommand.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleDashboardChat.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.getWidgetData.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.forceRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.startWidgetRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.stopWidgetRefresh.mock.calls.length, 1);
    });

    test('handles image reuse', async () => {
      const message = createMockMessage('the image');
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'direct' });
      mockBuffer.buildContext.mockReturnValue('context');
      mockClaude.getClawdResponse.mockResolvedValue('response');
      mockBuffer.pushMessage.mockImplementation(() => {});
      mockSse.broadcastSSE.mockImplementation(() => {});
      mockLogger.info.mockImplementation(() => {});
      mockLogger.debug.mockImplementation(() => {});
      mockLogger.warn.mockImplementation(() => {});
      mockLogger.error.mockImplementation(() => {});
      mockFs.readFile.mockResolvedValue('image data');
      mockVoiceHandler.handleVoiceLocal.mockImplementation(() => {});
      mockVoiceHandler.handleVoiceCommand.mockImplementation(() => {});
      mockVoiceHandler.handleDashboardChat.mockImplementation(() => {});
      mockWidgets.getWidgetData.mockImplementation(() => {});
      mockWidgets.forceRefresh.mockImplementation(() => {});
      mockWidgets.startWidgetRefresh.mockImplementation(() => {});
      mockWidgets.stopWidgetRefresh.mockImplementation(() => {});
      lastImageByChat.set('msg123', { data: { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'image data' } }, timestamp: Date.now() - 10000 });

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockBuffer.pushMessage.mock.calls.length, 1);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[0], 'msg123');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].senderName, 'User');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].text, 'response');
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].hasImage, true);
      assert.strictEqual(mockBuffer.pushMessage.mock.calls[0].arguments[1].isBot, false);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls.length, 1);
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[0], 'message');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].sender, 'User');
      assert.strictEqual(mockSse.broadcastSSE.mock.calls[0].arguments[1].text, 'response');
      assert.strictEqual(mockLogger.info.mock.calls.length, 1);
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].mode, 'direct');
      assert.strictEqual(mockLogger.info.mock.calls[0].arguments[0].chat, 'msg123');
      assert.strictEqual(mockLogger.debug.mock.calls.length, 1);
      assert.strictEqual(mockLogger.debug.mock.calls[0].arguments[0].msgId, 'msg123');
      assert.strictEqual(mockLogger.warn.mock.calls.length, 0);
      assert.strictEqual(mockLogger.error.mock.calls.length, 0);
      assert.strictEqual(mockFs.readFile.mock.calls.length, 1);
      assert.strictEqual(mockFs.readFile.mock.calls[0].arguments[0], 'image data');
      assert.strictEqual(mockVoiceHandler.handleVoiceLocal.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleVoiceCommand.mock.calls.length, 1);
      assert.strictEqual(mockVoiceHandler.handleDashboardChat.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.getWidgetData.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.forceRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.startWidgetRefresh.mock.calls.length, 1);
      assert.strictEqual(mockWidgets.stopWidgetRefresh.mock.calls.length, 1);
    });

    test('handles group mode exit', async () => {
      const message = createMockMessage('exit devil\'s advocate');
      mockTrigger.shouldRespond.mockReturnValue({ respond: true, mode: 'passive' });
      mockGroupModes.detectGroupModeExit.mockReturnValue(true);
      mockBuffer.buildContext.mockReturnValue('context');
      mockClaude.getClawdResponse.mockResolvedValue('response');
      mockBuffer.pushMessage.mockImplementation(() => {});
      mockSse.broadcastSSE.mockImplementation(() => {});
      mockLogger.info.mockImplementation(() => {});
      mockLogger.debug.mockImplementation(() => {});
      mockLogger.warn.mockImplementation(() => {});
      mockLogger.error.mockImplementation(() => {});
      mockFs.readFile.mockResolvedValue('image data');
      mockVoiceHandler.handleVoiceLocal.mockImplementation(() => {});
      mockVoiceHandler.handleVoiceCommand.mockImplementation(() => {});
      mockVoiceHandler.handleDashboardChat.mockImplementation(() => {});
      mockWidgets.getWidgetData.mockImplementation(() => {});
      mockWidgets.forceRefresh.mockImplementation(() => {});
      mockWidgets.startWidgetRefresh.mockImplementation(() => {});
      mockWidgets.stopWidgetRefresh.mockImplementation(() => {});

      await mod.handleIncomingMessage(mockSock, message, mockBotJid);

      assert.strictEqual(mockGroupModes.detectGroupModeExit.mock.calls.length, 1);
      assert.strictEqual(mockGroupModes.detectGroupModeExit.mock.calls[0].arguments[0], 'exit devil\'s advocate');
      assert.strictEqual(mockGroupModes.detectGroupModeExit.mock.calls[0].arguments[1], 'msg123');
      assert.strictEqual(mockBuffer.buildContext.mock.calls.length,