import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import esmock from 'esmock';

describe('qwen-chat request telemetry', () => {
  it('logs payload metrics without prompt contents', async () => {
    const infoLogs = [];
    const { createQwenChatClient } = await esmock('../src/qwen-chat.js', {
      '../src/logger.js': {
        default: {
          info: (fields, message) => infoLogs.push({ fields, message }),
          warn: () => {},
        },
      },
    });

    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        usage: { prompt_tokens: 123, completion_tokens: 9 },
      }),
      text: async () => '',
    });

    const client = createQwenChatClient({ baseUrl: 'http://localhost:8080', fetchFn });
    await client.messages.create({
      model: 'qwen3.6-27b',
      system: 'SECRET_SYSTEM_PROMPT',
      messages: [{ role: 'user', content: 'SECRET_USER_PROMPT' }],
      tools: [{ name: 'web_search', description: 'Search', input_schema: { type: 'object' } }],
    });

    const telemetry = infoLogs.find((entry) => entry.message === 'qwen-chat request complete');
    assert.ok(telemetry, 'expected qwen telemetry log');
    assert.equal(telemetry.fields.toolCount, 1);
    assert.equal(typeof telemetry.fields.payloadChars, 'number');
    assert.equal(typeof telemetry.fields.elapsedMs, 'number');
    assert.equal(telemetry.fields.promptTokens, 123);
    assert.equal(telemetry.fields.completionTokens, 9);
    assert.equal(JSON.stringify(telemetry.fields).includes('SECRET'), false);
  });
});
