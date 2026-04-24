// src/qwen-chat.js — Qwen3.6-27B local chat client, Anthropic-SDK-shaped.
//
// Wraps the llama.cpp OpenAI-compatible /v1/chat/completions endpoint on
// EVO :8080 (or whichever port EVO_LLM_URL points at) in the shape the
// existing LLMService (claude.js) expects — `{ messages: { create(opts) } }`
// returning `{content: [{type, ...}], stop_reason, usage}`.
//
// This is a translation layer, not a full Anthropic-API implementation.
// Scope limited to what LLMService actually calls:
//   - messages.create({ model, max_tokens, system, messages, tools })
//   - response.content as [{type: 'text', text}] or [..., {type: 'tool_use', id, name, input}]
//   - response.stop_reason 'end_turn' | 'tool_use'
//   - response.usage {input_tokens, output_tokens, cache_read_input_tokens?}
//
// Image content is NOT handled here — callers detect image and route to
// MiniMax instead. The 27B dense has no vision head; MiniMax does.

import logger from './logger.js';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Flatten an Anthropic `system` value to a single string. Supports the
 * existing LLMService usage:
 *   - string
 *   - array of {type: 'text', text, cache_control?}
 * Cache-control is lost in translation; llama.cpp's prompt-cache is whole-
 * prefix, so we pass `cache_prompt: true` at the request level.
 */
function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && (typeof b === 'string' || b.type === 'text'))
      .map((b) => (typeof b === 'string' ? b : b.text))
      .join('\n\n');
  }
  return '';
}

/**
 * Translate an Anthropic messages array → OpenAI messages array.
 * Handles:
 *   - user text (string or array-of-blocks with type:'text')
 *   - user tool_result blocks → emit as {role:'tool', tool_call_id, content}
 *   - assistant content blocks → OpenAI {role:'assistant', content, tool_calls}
 */
function translateMessages(anthropicMessages) {
  const out = [];
  for (const msg of anthropicMessages || []) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      // Split: text blocks collate; tool_result blocks each become a
      // separate {role:'tool', ...} message in OpenAI's schema.
      const textParts = [];
      const toolResults = [];
      for (const b of blocks) {
        if (b && b.type === 'text') textParts.push(b.text || '');
        else if (b && b.type === 'tool_result') {
          toolResults.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
          });
        }
        // Image blocks are explicitly not supported here — caller routes
        // elsewhere when imageData is present.
      }
      if (textParts.length > 0) out.push({ role: 'user', content: textParts.join('\n') });
      out.push(...toolResults);
    } else if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const m = { role: 'assistant' };
      if (text) m.content = text;
      if (toolCalls.length > 0) m.tool_calls = toolCalls;
      if (text || toolCalls.length > 0) out.push(m);
    }
  }
  return out;
}

/**
 * Translate Anthropic tools → OpenAI tools.
 * Anthropic: {name, description, input_schema}
 * OpenAI:    {type: 'function', function: {name, description, parameters}}
 */
function translateTools(anthropicTools) {
  if (!Array.isArray(anthropicTools) || anthropicTools.length === 0) return undefined;
  return anthropicTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

/**
 * Translate an OpenAI /v1/chat/completions response → Anthropic-shape
 * message response. Pure function for testability.
 */
export function translateOpenAIResponseToAnthropic(oai) {
  const choice = oai?.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try {
      input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      // Llama.cpp occasionally emits near-JSON for tool args (trailing
      // commas, quote escaping). Best-effort — pass raw string if parse
      // fails so the tool handler can decide how to handle it.
      input = { _raw: tc.function?.arguments || '' };
    }
    content.push({
      type: 'tool_use',
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: tc.function?.name || 'unknown',
      input,
    });
  }
  // stop_reason mapping: finish_reason 'tool_calls' → 'tool_use',
  // anything else → 'end_turn'.
  const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: oai?.usage?.prompt_tokens || 0,
      output_tokens: oai?.usage?.completion_tokens || 0,
      // llama.cpp's prompt-cache hits aren't reported per-token in the
      // OpenAI shape; expose as 0 here. The existing LLMService only
      // uses this for logging display so a zero is harmless.
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * The public surface: an object with `messages.create()` that LLMService
 * can call interchangeably with the Anthropic SDK's client.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl — llama-server base URL, e.g. http://localhost:8080
 * @param {string} opts.defaultModel — model label for logs (llama-server ignores this and uses whatever is loaded)
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn] — injected for tests
 */
export function createQwenChatClient({ baseUrl, defaultModel = 'qwen3.6-27b', timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error('createQwenChatClient: baseUrl required');
  const normalisedBase = baseUrl.replace(/\/+$/, '');

  async function create({ model, max_tokens = 1024, system, messages, tools } = {}) {
    const url = `${normalisedBase}/v1/chat/completions`;
    const oaiMessages = [];
    const sys = flattenSystem(system);
    if (sys) oaiMessages.push({ role: 'system', content: sys });
    oaiMessages.push(...translateMessages(messages));

    const payload = {
      model: model || defaultModel,
      messages: oaiMessages,
      max_tokens,
      temperature: 0.7,
      cache_prompt: true,                    // llama.cpp whole-prefix cache
      stream: false,
    };
    const oaiTools = translateTools(tools);
    if (oaiTools) {
      payload.tools = oaiTools;
      payload.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Surface as the Anthropic-ish null that LLMService handles.
      logger.warn({ err: err.message, url }, 'qwen-chat: request failed');
      throw err;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'qwen-chat: non-2xx');
      throw new Error(`qwen-chat ${res.status}: ${body.slice(0, 200)}`);
    }
    const oai = await res.json();
    return translateOpenAIResponseToAnthropic(oai);
  }

  return { messages: { create } };
}

// Named exports for unit tests.
export { flattenSystem, translateMessages, translateTools };
