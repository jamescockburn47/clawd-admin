// src/debate-handler.js — LQ Bot Council debate endpoint orchestrator.
// MiniMax M2.7 (primary) drives the tool loop — web_search, web_fetch,
// memory_search — to ground each debate round in real evidence. EVO local
// (Qwen3-30B) is the fallback when MiniMax is unreachable or unconfigured;
// it has no tools.

import Anthropic from '@anthropic-ai/sdk';
import { executeTool } from './tools/handler.js';
import config from './config.js';
import logger from './logger.js';
import {
  DEBATE_TOOLS,
  MAX_TOOL_LOOPS,
  MAX_TOOL_RESULT,
  DEBATE_REQUEST_TIMEOUT_MS,
  buildDebateSystemPrompt,
} from './debate/prompt.js';
import { parseModelResponse } from './debate/parser.js';

/** Call MiniMax with tools via the Anthropic-compatible SDK. */
async function callMiniMaxWithTools(systemPrompt) {
  if (!config.minimaxApiKey || !config.minimaxEnabled) return null;

  const client = new Anthropic({
    apiKey: config.minimaxApiKey,
    baseURL: config.minimaxBaseUrl,
  });

  const messages = [{ role: 'user', content: 'Research the topic using your tools, then respond with the required JSON.' }];

  let response = await client.messages.create({
    model: config.minimaxModel,
    max_tokens: 4000,
    system: systemPrompt,
    messages,
    tools: DEBATE_TOOLS,
  });

  let loopCount = 0;
  const toolsUsed = [];

  while (response.stop_reason === 'tool_use' && loopCount < MAX_TOOL_LOOPS) {
    loopCount++;
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });
    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      logger.info({ tool: toolUse.name, input: toolUse.input }, 'debate: tool call');
      toolsUsed.push(toolUse.name);
      let result = await executeTool(toolUse.name, toolUse.input, null, null);
      if (result.length > MAX_TOOL_RESULT) result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: config.minimaxModel,
      max_tokens: 4000,
      system: systemPrompt,
      messages,
      tools: DEBATE_TOOLS,
    });

    logger.info(
      { loop: loopCount, input: response.usage?.input_tokens, output: response.usage?.output_tokens },
      'debate: tool loop',
    );
  }

  // Loop cap hit with model still asking for tools — force a text turn by
  // replying to the pending tool_use blocks with an empty result prompt.
  if (response.stop_reason === 'tool_use') {
    logger.info({ loopCount }, 'debate: tool loop limit reached, forcing text response');
    messages.push({ role: 'assistant', content: response.content });
    const pendingTools = response.content.filter((b) => b.type === 'tool_use');
    const emptyResults = pendingTools.map((t) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: '[tool call limit reached — respond with the evidence you have]',
    }));
    messages.push({ role: 'user', content: emptyResults });

    response = await client.messages.create({
      model: config.minimaxModel,
      max_tokens: 4000,
      system: systemPrompt,
      messages,
    });
  }

  const textBlock = response.content?.find((b) => b.type === 'text');
  return { text: textBlock?.text || null, toolsUsed };
}

/** Call EVO local model as fallback (no tools — just prompt in, text out). */
async function callEvoLocal(systemPrompt) {
  const resp = await fetch(`${config.evoLlmUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Respond now with the required JSON.' },
      ],
      max_tokens: 4000,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(DEBATE_REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`EVO local returned ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || null;
}

/** Handle a POST /debate request from the Bot Council. */
export async function handleDebate(body) {
  const { session_id, round, role, context, prompt } = body;

  logger.info({ session_id, round, role }, 'debate: received round request');

  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { response: 'No prompt provided for this debate round.', confidence: 50 };
  }

  const systemPrompt = buildDebateSystemPrompt({ round, role, context: context || [], prompt });

  let rawText = null;
  let toolsUsed = [];
  let model = 'unknown';

  try {
    const result = await callMiniMaxWithTools(systemPrompt);
    if (result?.text) {
      rawText = result.text;
      toolsUsed = result.toolsUsed;
      model = config.minimaxModel;
    }
  } catch (err) {
    logger.warn({ err: err.message, session_id }, 'debate: MiniMax call failed, falling back to EVO');
  }

  if (!rawText) {
    try {
      rawText = await callEvoLocal(systemPrompt);
      if (rawText) model = 'Qwen3-30B-local';
    } catch (err) {
      logger.error({ err: err.message, session_id }, 'debate: EVO local call also failed');
    }
  }

  if (!rawText) {
    logger.error({ session_id, round }, 'debate: all model calls failed');
    return { response: 'I was unable to formulate a response for this round.', confidence: 50 };
  }

  const parsed = parseModelResponse(rawText, round);

  logger.info(
    {
      session_id,
      round,
      model,
      responseLength: parsed.response?.length,
      toolsUsed: toolsUsed.length > 0 ? toolsUsed.join(', ') : 'none',
    },
    'debate: response ready',
  );

  return parsed;
}
