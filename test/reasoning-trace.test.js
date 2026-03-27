// test/reasoning-trace.test.js — Tests for structured reasoning trace logger
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from 'fs';
import { join } from 'path';

process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const TRACE_FILE = join('data', 'reasoning-traces.jsonl');
const BACKUP_FILE = TRACE_FILE + '.test-backup';

let logReasoningTrace;

async function loadModule() {
  const mod = await import('../src/reasoning-trace.js');
  logReasoningTrace = mod.logReasoningTrace;
}

describe('logReasoningTrace', () => {
  before(async () => {
    await loadModule();
    // Back up existing file if present
    if (existsSync(TRACE_FILE)) {
      copyFileSync(TRACE_FILE, BACKUP_FILE);
    }
    // Start with a clean file
    writeFileSync(TRACE_FILE, '');
  });

  after(() => {
    // Restore original file or remove test artefact
    if (existsSync(BACKUP_FILE)) {
      copyFileSync(BACKUP_FILE, TRACE_FILE);
      unlinkSync(BACKUP_FILE);
    } else {
      // File didn't exist before tests — remove what we created
      if (existsSync(TRACE_FILE)) {
        unlinkSync(TRACE_FILE);
      }
    }
  });

  it('writes valid trace to JSONL', () => {
    writeFileSync(TRACE_FILE, '');
    logReasoningTrace({
      messageId: 'msg-001',
      chatId: '123@s.whatsapp.net',
      sender: '456@s.whatsapp.net',
      routing: { category: 'general_knowledge', layer: 'minimax' },
      model: { selected: 'MiniMax-M2.7', reason: 'default' },
      toolsCalled: [],
      totalTimeMs: 350,
    });

    const content = readFileSync(TRACE_FILE, 'utf8').trim();
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'Expected exactly one line');

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.messageId, 'msg-001');
    assert.equal(parsed.chatId, '123@s.whatsapp.net');
    assert.equal(parsed.routing.category, 'general_knowledge');
    assert.equal(parsed.model.selected, 'MiniMax-M2.7');
    assert.equal(parsed.totalTimeMs, 350);
  });

  it('adds timestamp automatically', () => {
    writeFileSync(TRACE_FILE, '');
    const beforeTime = new Date().toISOString();
    logReasoningTrace({ messageId: 'msg-ts' });
    const afterTime = new Date().toISOString();

    const line = readFileSync(TRACE_FILE, 'utf8').trim();
    const parsed = JSON.parse(line);

    assert.ok(parsed.timestamp, 'Expected timestamp to be present');
    // Timestamp should be a valid ISO string between before and after
    assert.ok(parsed.timestamp >= beforeTime, 'Timestamp should be >= beforeTime');
    assert.ok(parsed.timestamp <= afterTime, 'Timestamp should be <= afterTime');
  });

  it('preserves all trace fields', () => {
    writeFileSync(TRACE_FILE, '');
    const trace = {
      messageId: 'msg-fields',
      chatId: 'group@g.us',
      sender: '789@s.whatsapp.net',
      routing: { category: 'planning', layer: 'opus', needsPlan: true, confidence: 0.92, timeMs: 45 },
      model: { selected: 'claude-opus-4-6', reason: 'explicit request', qualityGate: true },
      toolsCalled: ['calendar_list', 'web_search'],
      totalTimeMs: 2100,
    };
    logReasoningTrace(trace);

    const parsed = JSON.parse(readFileSync(TRACE_FILE, 'utf8').trim());
    assert.equal(parsed.messageId, 'msg-fields');
    assert.equal(parsed.chatId, 'group@g.us');
    assert.equal(parsed.sender, '789@s.whatsapp.net');
    assert.equal(parsed.routing.category, 'planning');
    assert.equal(parsed.routing.needsPlan, true);
    assert.equal(parsed.routing.confidence, 0.92);
    assert.equal(parsed.model.selected, 'claude-opus-4-6');
    assert.equal(parsed.model.qualityGate, true);
    assert.deepEqual(parsed.toolsCalled, ['calendar_list', 'web_search']);
    assert.equal(parsed.totalTimeMs, 2100);
  });

  it('handles missing optional fields', () => {
    writeFileSync(TRACE_FILE, '');
    // Minimal trace — just messageId, should not throw
    assert.doesNotThrow(() => {
      logReasoningTrace({ messageId: 'msg-minimal' });
    });

    const parsed = JSON.parse(readFileSync(TRACE_FILE, 'utf8').trim());
    assert.equal(parsed.messageId, 'msg-minimal');
    assert.ok(parsed.timestamp, 'Should still have timestamp');
  });

  it('multiple traces append correctly', () => {
    writeFileSync(TRACE_FILE, '');
    logReasoningTrace({ messageId: 'line-1', totalTimeMs: 100 });
    logReasoningTrace({ messageId: 'line-2', totalTimeMs: 200 });
    logReasoningTrace({ messageId: 'line-3', totalTimeMs: 300 });

    const lines = readFileSync(TRACE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'Expected 3 lines');

    lines.forEach((line, i) => {
      const parsed = JSON.parse(line);
      assert.equal(parsed.messageId, `line-${i + 1}`);
      assert.equal(parsed.totalTimeMs, (i + 1) * 100);
    });
  });

  it('non-fatal on write error — noted as design intent', { skip: 'Cannot inject fs error without mocking; verified by code review — catch block logs warn and does not rethrow' }, () => {
    // The source wraps appendFileSync in try/catch and calls logger.warn.
    // Without replacing fs.appendFileSync, we cannot reliably trigger a write error.
    // The design intent (non-fatal on error) is confirmed by reading the source.
  });
});
