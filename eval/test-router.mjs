// test-router.mjs
process.env.ANTHROPIC_API_KEY = 'test-placeholder';

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { mock } from 'node:test';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Mock file system operations
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock evo-llm and evo-client
const evoLlmMock = {
  classifyVia4B: mock.fn(),
  classifyViaEvo: mock.fn(),
};
const evoClientMock = {
  plannerBreaker: {
    call: mock.fn(),
  },
};

// Mock config
const configMock = {
  ANTHROPIC_API_KEY: 'test-placeholder',
};

// Mock constants
const CATEGORY = {
  CALENDAR: 'calendar',
  TASK: 'task',
  TRAVEL: 'travel',
  EMAIL: 'email',
  RECALL: 'recall',
  PLANNING: 'planning',
  CONVERSATIONAL: 'conversational',
  GENERAL_KNOWLEDGE: 'general_knowledge',
  SYSTEM: 'system',
};

// Mock logger
const loggerMock = {
  info: mock.fn(),
  warn: mock.fn(),
  debug: mock.fn(),
};

// Mock file system
const fsMock = {
  existsSync: mock.fn(),
  readFileSync: mock.fn(),
};

// Mock circuit breaker
const circuitBreakerMock = {
  isOpen: mock.fn(),
  recordSuccess: mock.fn(),
  recordFailure: mock.fn(),
};

// Mock dependencies
const mockImports = {
  './evo-llm.js': evoLlmMock,
  './evo-client.js': evoClientMock,
  './config.js': configMock,
  './logger.js': loggerMock,
  'fs': fsMock,
  'path': { join },
};

// Import router with mocked dependencies
const mod = await import('../src/router.js');

// Set up test environment
const { 
  getToolsForCategory, 
  needsMemories, 
  classifyByKeywords, 
  classifyByLLM, 
  classifyMessage, 
  mustUseClaude,
  CATEGORY: exportedCategory,
  READ_SAFE_TOOLS,
  WRITE_DANGEROUS_TOOLS,
  detectsWriteIntent,
  KEYWORD_RULES,
  CLAUDE_CATEGORIES,
  WRITE_LIKELY_CATEGORIES,
} = mod;

// Test utility functions
function createMockTools() {
  return [
    { name: 'web_search' },
    { name: 'web_fetch' },
    { name: 'calendar_list_events' },
    { name: 'todo_add' },
    { name: 'gmail_search' },
    { name: 'memory_search' },
  ];
}

// Test getToolsForCategory
describe('getToolsForCategory', () => {
  test('returns all tools for PLANNING category', () => {
    const allTools = createMockTools();
    const result = getToolsForCategory(CATEGORY.PLANNING, allTools);
    assert.strictEqual(result.length, allTools.length);
  });

  test('returns category-specific tools for CALENDAR', () => {
    const allTools = createMockTools();
    const result = getToolsForCategory(CATEGORY.CALENDAR, allTools);
    assert.strictEqual(result.length, 2);
    assert.ok(result.some(t => t.name === 'calendar_list_events'));
    assert.ok(result.some(t => t.name === 'calendar_find_free_time'));
  });

  test('includes web_search and web_fetch for all categories', () => {
    const allTools = createMockTools();
    const result = getToolsForCategory(CATEGORY.CALENDAR, allTools);
    assert.ok(result.some(t => t.name === 'web_search'));
    assert.ok(result.some(t => t.name === 'web_fetch'));
  });

  test('returns empty array for unknown category', () => {
    const allTools = createMockTools();
    const result = getToolsForCategory('unknown', allTools);
    assert.strictEqual(result.length, 0);
  });
});

// Test needsMemories
describe('needsMemories', () => {
  test('returns true for MEMORY_CATEGORIES', () => {
    assert.strictEqual(needsMemories(CATEGORY.TRAVEL), true);
    assert.strictEqual(needsMemories(CATEGORY.RECALL), true);
    assert.strictEqual(needsMemories(CATEGORY.PLANNING), true);
    assert.strictEqual(needsMemories(CATEGORY.SYSTEM), true);
  });

  test('returns false for non-MEMORY_CATEGORIES', () => {
    assert.strictEqual(needsMemories(CATEGORY.CALENDAR), false);
    assert.strictEqual(needsMemories(CATEGORY.TASK), false);
    assert.strictEqual(needsMemories(CATEGORY.EMAIL), false);
    assert.strictEqual(needsMemories(CATEGORY.CONVERSATIONAL), false);
    assert.strictEqual(needsMemories(CATEGORY.GENERAL_KNOWLEDGE), false);
  });
});

// Test classifyByKeywords
describe('classifyByKeywords', () => {
  test('returns category for exact keyword match', () => {
    const result = classifyByKeywords('I want to check my calendar');
    assert.strictEqual(result, CATEGORY.CALENDAR);
  });

  test('returns category for email keywords', () => {
    const result = classifyByKeywords('Send an email to John');
    assert.strictEqual(result, CATEGORY.EMAIL);
  });

  test('returns category for task keywords', () => {
    const result = classifyByKeywords('Add a todo for tomorrow');
    assert.strictEqual(result, CATEGORY.TASK);
  });

  test('returns category for travel keywords', () => {
    const result = classifyByKeywords('Find train tickets to London');
    assert.strictEqual(result, CATEGORY.TRAVEL);
  });

  test('returns category for system keywords', () => {
    const result = classifyByKeywords('What is the system status?');
    assert.strictEqual(result, CATEGORY.SYSTEM);
  });

  test('returns category for general knowledge keywords', () => {
    const result = classifyByKeywords('What is the capital of France?');
    assert.strictEqual(result, CATEGORY.GENERAL_KNOWLEDGE);
  });

  test('returns null for ambiguous or no match', () => {
    const result = classifyByKeywords('Hello, how are you?');
    assert.strictEqual(result, null);
  });

  test('returns null for non-matching text', () => {
    const result = classifyByKeywords('This is a random sentence');
    assert.strictEqual(result, null);
  });

  test('handles empty text', () => {
    const result = classifyByKeywords('');
    assert.strictEqual(result, null);
  });

  test('handles null text', () => {
    const result = classifyByKeywords(null);
    assert.strictEqual(result, null);
  });

  test('handles undefined text', () => {
    const result = classifyByKeywords(undefined);
    assert.strictEqual(result, null);
  });

  test('handles very long text', () => {
    const longText = 'a '.repeat(1000) + 'calendar';
    const result = classifyByKeywords(longText);
    assert.strictEqual(result, CATEGORY.CALENDAR);
  });

  test('handles text with special characters', () => {
    const result = classifyByKeywords('Check my calendar! @#$%^&*()');
    assert.strictEqual(result, CATEGORY.CALENDAR);
  });

  test('handles text with mixed case', () => {
    const result = classifyByKeywords('cHeCk mY cAlEnDaR');
    assert.strictEqual(result, CATEGORY.CALENDAR);
  });

  test('handles text with punctuation', () => {
    const result = classifyByKeywords('Check my calendar, please.');
    assert.strictEqual(result, CATEGORY.CALENDAR);
  });

  test('handles text with numbers', () => {
    const result = classifyByKeywords('Check my calendar for 10:00 AM');
    assert.strictEqual(result, CATEGORY.CALENDAR);
  });

  test('handles text with multiple keywords', () => {
    const result = classifyByKeywords('Check my calendar and send an email');
    assert.strictEqual(result, null); // ambiguous
  });

  test('handles text with learned rules', () => {
    // Mock learned rules
    const originalRules = KEYWORD_RULES;
    KEYWORD_RULES.push({
      category: CATEGORY.PLANNING,
      test: (lower) => /learned rule/.test(lower),
    });

    const result = classifyByKeywords('This is a learned rule');
    assert.strictEqual(result, CATEGORY.PLANNING);

    // Restore original rules
    KEYWORD_RULES.length = originalRules.length;
    KEYWORD_RULES.push(...originalRules);
  });
});

// Test classifyByLLM
describe('classifyByLLM', () => {
  test('returns category from LLM classifier', async () => {
    evoLlmMock.classifyViaEvo.mockResolvedValue('calendar');
    const result = await classifyByLLM('Check my calendar');
    assert.strictEqual(result, 'calendar');
  });

  test('returns null for invalid LLM response', async () => {
    evoLlmMock.classifyViaEvo.mockResolvedValue('invalid_category');
    const result = await classifyByLLM('Check my calendar');
    assert.strictEqual(result, null);
  });

  test('returns null for LLM classifier failure', async () => {
    evoLlmMock.classifyViaEvo.mockRejectedValue(new Error('LLM failed'));
    const result = await classifyByLLM('Check my calendar');
    assert.strictEqual(result, null);
  });

  test('handles circuit breaker open', async () => {
    circuitBreakerMock.isOpen.mockReturnValue(true);
    const result = await classifyByLLM('Check my calendar');
    assert.strictEqual(result, null);
  });

  test('handles circuit breaker closed', async () => {
    circuitBreakerMock.isOpen.mockReturnValue(false);
    evoLlmMock.classifyViaEvo.mockResolvedValue('calendar');
    const result = await classifyByLLM('Check my calendar');
    assert.strictEqual(result, 'calendar');
  });

  test('handles empty text', async () => {
    const result = await classifyByLLM('');
    assert.strictEqual(result, null);
  });

  test('handles null text', async () => {
    const result = await classifyByLLM(null);
    assert.strictEqual(result, null);
  });

  test('handles undefined text', async () => {
    const result = await classifyByLLM(undefined);
    assert.strictEqual(result, null);
  });

  test('handles very long text', async () => {
    const longText = 'a '.repeat(1000) + 'check my calendar';
    evoLlmMock.classifyViaEvo.mockResolvedValue('calendar');
    const result = await classifyByLLM(longText);
    assert.strictEqual(result, 'calendar');
  });

  test('handles text with special characters', async () => {
    const result = await classifyByLLM('Check my calendar! @#$%^&*()');
    assert.strictEqual(result, 'calendar');
  });

  test('handles text with mixed case', async () => {
    const result = await classifyByLLM('cHeCk mY cAlEnDaR');
    assert.strictEqual(result, 'calendar');
  });

  test('handles text with punctuation', async () => {
    const result = await classifyByLLM('Check my calendar, please.');
    assert.strictEqual(result, 'calendar');
  });

  test('handles text with numbers', async () => {
    const result = await classifyByLLM('Check my calendar for 10:00 AM');
    assert.strictEqual(result, 'calendar');
  });
});

// Test classifyMessage
describe('classifyMessage', () => {
  test('returns category for image input', async () => {
    const result = await classifyMessage('Hello', true);
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'image');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, 'image input — EVO VL model preferred');
  });

  test('returns category from 4B classifier', async () => {
    evoLlmMock.classifyVia4B.mockResolvedValue({
      category: 'calendar',
      confidence: 0.95,
      needsPlan: false,
      planReason: null,
    });
    const result = await classifyMessage('Check my calendar');
    assert.strictEqual(result.category, 'calendar');
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('returns category from keywords fallback', async () => {
    evoLlmMock.classifyVia4B.mockResolvedValue(null);
    const result = await classifyMessage('Check my calendar');
    assert.strictEqual(result.category, CATEGORY.CALENDAR);
    assert.strictEqual(result.source, 'keywords_fallback');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('returns category from LLM classifier', async () => {
    evoLlmMock.classifyVia4B.mockResolvedValue(null);
    evoLlmMock.classifyViaEvo.mockResolvedValue('calendar');
    const result = await classifyMessage('Check my calendar');
    assert.strictEqual(result.category, 'calendar');
    assert.strictEqual(result.source, 'llm_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('returns fallback category', async () => {
    evoLlmMock.classifyVia4B.mockResolvedValue(null);
    evoLlmMock.classifyViaEvo.mockResolvedValue(null);
    const result = await classifyMessage('Check my calendar');
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'fallback');
    assert.strictEqual(result.forceClaude, true);
    assert.strictEqual(result.reason, 'no confident classification');
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('handles empty text', async () => {
    const result = await classifyMessage('');
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'fallback');
    assert.strictEqual(result.forceClaude, true);
    assert.strictEqual(result.reason, 'no confident classification');
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('handles null text', async () => {
    const result = await classifyMessage(null);
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'fallback');
    assert.strictEqual(result.forceClaude, true);
    assert.strictEqual(result.reason, 'no confident classification');
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('handles undefined text', async () => {
    const result = await classifyMessage(undefined);
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'fallback');
    assert.strictEqual(result.forceClaude, true);
    assert.strictEqual(result.reason, 'no confident classification');
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('handles very long text', async () => {
    const longText = 'a '.repeat(1000) + 'check my calendar';
    evoLlmMock.classifyVia4B.mockResolvedValue({
      category: 'calendar',
      confidence: 0.95,
      needsPlan: false,
      planReason: null,
    });
    const result = await classifyMessage(longText);
    assert.strictEqual(result.category, 'calendar');
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('handles text with special characters', async () => {
    const result = await classifyMessage('Check my calendar! @#$%^&*()');
    assert.strictEqual(result.category, CATEGORY.CALENDAR);
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('handles text with mixed case', async () => {
    const result = await classifyMessage('cHeCk mY cAlEnDaR');
    assert.strictEqual(result.category, CATEGORY.CALENDAR);
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('handles text with punctuation', async () => {
    const result = await classifyMessage('Check my calendar, please.');
    assert.strictEqual(result.category, CATEGORY.CALENDAR);
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('handles text with numbers', async () => {
    const result = await classifyMessage('Check my calendar for 10:00 AM');
    assert.strictEqual(result.category, CATEGORY.CALENDAR);
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('handles circuit breaker open', async () => {
    circuitBreakerMock.isOpen.mockReturnValue(true);
    const result = await classifyMessage('Check my calendar');
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'fallback');
    assert.strictEqual(result.forceClaude, true);
    assert.strictEqual(result.reason, 'no confident classification');
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, null);
  });

  test('handles circuit breaker closed', async () => {
    circuitBreakerMock.isOpen.mockReturnValue(false);
    evoLlmMock.classifyVia4B.mockResolvedValue({
      category: 'calendar',
      confidence: 0.95,
      needsPlan: false,
      planReason: null,
    });
    const result = await classifyMessage('Check my calendar');
    assert.strictEqual(result.category, 'calendar');
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });

  test('handles image with text', async () => {
    const result = await classifyMessage('Hello', true);
    assert.strictEqual(result.category, CATEGORY.PLANNING);
    assert.strictEqual(result.source, 'image');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, 'image input — EVO VL model preferred');
  });

  test('handles group messages', async () => {
    evoLlmMock.classifyVia4B.mockResolvedValue({
      category: 'calendar',
      confidence: 0.95,
      needsPlan: false,
      planReason: null,
    });
    const result = await classifyMessage('Check my calendar', false, true);
    assert.strictEqual(result.category, 'calendar');
    assert.strictEqual(result.source, '4b_classifier');
    assert.strictEqual(result.forceClaude, false);
    assert.strictEqual(result.reason, null);
    assert.strictEqual(result.needsPlan, false);
    assert.strictEqual(result.planReason, null);
    assert.strictEqual(result.confidence, 0.95);
  });
});

// Test mustUseClaude
describe('mustUseClaude', () => {
  test('returns true for CLAUDE_CATEGORIES', () => {
    assert.strictEqual(mustUseClaude(CATEGORY.EMAIL), true);
    assert.strictEqual(mustUseClaude(CATEGORY.PLANNING), true);
    assert.strictEqual(mustUseClaude(CATEGORY.RECALL), true);
    assert.strictEqual(mustUseClaude(CATEGORY.SYSTEM), true);
  });

  test('returns false for non-CLAUDE_CATEGORIES', () => {
    assert.strictEqual(mustUseClaude(CATEGORY.CALENDAR), false);
    assert.strictEqual(mustUseClaude(CATEGORY.TASK), false);
    assert.strictEqual(mustUseClaude(CATEGORY.TRAVEL), false);
    assert.strictEqual(mustUseClaude(CATEGORY.CONVERSATIONAL), false);
    assert.strictEqual(mustUseClaude(CATEGORY.GENERAL_KNOWLEDGE), false);
  });

  test('returns false for unknown category', () => {
    assert.strictEqual(mustUseClaude('unknown'), false);
  });

  test('handles empty category', () => {
    assert.strictEqual(mustUseClaude(''), false);
  });

  test('handles null category', () => {
    assert.strictEqual(mustUseClaude(null), false);
  });

  test('handles undefined category', () => {
    assert.strictEqual(mustUseClaude(undefined), false);
  });
});

// Test exported constants
describe('exported constants', () => {
  test('exports CATEGORY', () => {
    assert.strictEqual(exportedCategory, CATEGORY);
  });

  test('exports READ_SAFE_TOOLS', () => {
    assert.ok(READ_SAFE_TOOLS instanceof Set);
    assert.ok(READ_SAFE_TOOLS.has('todo_list'));
    assert.ok(READ_SAFE_TOOLS.has('calendar_list_events'));
    assert.ok(READ_SAFE_TOOLS.has('memory_search'));
    assert.ok(READ_SAFE_TOOLS.has('system_status'));
  });

  test('exports WRITE_DANGEROUS_TOOLS', () => {
    assert.ok(WRITE_DANGEROUS_TOOLS instanceof Set);
    assert.ok(WRITE_DANGEROUS_TOOLS.has('gmail_draft'));
    assert.ok(WRITE_DANGEROUS_TOOLS.has('gmail_confirm_send'));
    assert.ok(WRITE_DANGEROUS_TOOLS.has('calendar_create_event'));
    assert.ok(WRITE_DANGEROUS_TOOLS.has('soul_propose'));
    assert.ok(WRITE_DANGEROUS_TOOLS.has('memory_update'));
    assert.ok(WRITE_DANGEROUS_TOOLS.has('memory_delete'));
  });

  test('exports detectsWriteIntent', () => {
    assert.strictEqual(typeof detectsWriteIntent, 'function');
  });

  test('exports KEYWORD_RULES', () => {
    assert.ok(Array.isArray(KEYWORD_RULES));
    assert.ok(KEYWORD_RULES.length > 0);
    assert.ok(KEYWORD_RULES.every(r => typeof r.category === 'string'));
    assert.ok(KEYWORD_RULES.every(r => typeof r.test === 'function'));
  });

  test('exports CLAUDE_CATEGORIES', () => {
    assert.ok(CLAUDE_CATEGORIES instanceof Set);
    assert.ok(CLAUDE_CATEGORIES.has(CATEGORY.EMAIL));
    assert.ok(CLAUDE_CATEGORIES.has(CATEGORY.PLANNING));
    assert.ok(CLAUDE_CATEGORIES.has(CATEGORY.RECALL));
    assert.ok(CLAUDE_CATEGORIES.has(CATEGORY.SYSTEM));
  });

  test('exports WRITE_LIKELY_CATEGORIES', () => {
    assert.ok(WRITE_LIKELY_CATEGORIES instanceof Set);
    assert.ok(WRITE_LIKELY_CATEGORIES.has(CATEGORY.EMAIL));
  });
});

// Test detectsWriteIntent
describe('detectsWriteIntent', () => {
  test('returns true for calendar write intent', () => {
    assert.strictEqual(detectsWriteIntent('Create a meeting for tomorrow'), true);
    assert.strictEqual(detectsWriteIntent('Book an appointment for next week'), true);
    assert.strictEqual(detectsWriteIntent('Schedule a meeting with John'), true);
    assert.strictEqual(detectsWriteIntent('Update my calendar'), true);
    assert.strictEqual(detectsWriteIntent('Cancel my meeting'), true);
    assert.strictEqual(detectsWriteIntent('Reschedule my appointment'), true);
  });

  test('returns true for email write intent', () => {
    assert.strictEqual(detectsWriteIntent('Send an email to John'), true);
    assert.strictEqual(detectsWriteIntent('Draft a message to Mary'), true);
    assert.strictEqual(detectsWriteIntent('Write a reply to the team'), true);
    assert.strictEqual(detectsWriteIntent('Compose a new email'), true);
    assert.strictEqual(detectsWriteIntent('Forward the report to the manager'), true);
  });

  test('returns false for read-only calendar intent', () => {
    assert.strictEqual(detectsWriteIntent('Check my calendar'), false);
    assert.strictEqual(detectsWriteIntent('What events do I have tomorrow?'), false);
    assert.strictEqual(detectsWriteIntent('When is my next meeting?'), false);
    assert.strictEqual(detectsWriteIntent('What time is my appointment?'), false);
  });

  test('returns false for read-only email intent', () => {
    assert.strictEqual(detectsWriteIntent('Check my inbox'), false);
    assert.strictEqual(detectsWriteIntent('Read my emails'), false);
    assert.strictEqual(detectsWriteIntent('What emails do I have?'), false);
    assert.strictEqual(detectsWriteIntent('Check my sent messages'), false);
  });

  test('returns false for non-write intent', () => {
    assert.strictEqual(detectsWriteIntent('Hello, how are you?'), false);
    assert.strictEqual(detectsWriteIntent('What is the weather like today?'), false);
    assert.strictEqual(detectsWriteIntent('Tell me a joke'), false);
    assert.strictEqual(detectsWriteIntent('What time is it?'), false);
  });

  test('returns false for empty text', () => {
    assert.strictEqual(detectsWriteIntent(''), false);
  });

  test('returns false for null text', () => {
    assert.strictEqual(detectsWriteIntent(null), false);
  });

  test('returns false for undefined text', () => {
    assert.strictEqual(detectsWriteIntent(undefined), false);
  });

  test('returns false for very long text', () => {
    const longText = 'a '.repeat(1000) + 'create a meeting';
    assert.strictEqual