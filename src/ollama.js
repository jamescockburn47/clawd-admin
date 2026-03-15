// EVO X2 local model integration via Ollama (qwen3.5:35b)
// Handles tool calling and response generation locally, falling back to Claude
import config from './config.js';
import logger from './logger.js';
import { executeTool } from './tools/handler.js';

// Convert Anthropic-style tool definitions to Ollama format
function toOllamaTools(tools) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Build a lean system prompt for EVO X2 — tailored per activity category
function buildEvoSystemPrompt(category = null) {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });

  let base = `You are Clawd, James's personal assistant on WhatsApp. Be concise and direct.

Today is ${dateStr}, ${timeStr} (Europe/London).`;

  if (category === 'recall') {
    base += `\n\n## Rules
- Answer from the memories provided below. If no relevant memory exists, say "I don't have that stored."
- Do NOT guess or infer — only report what is in your memories.
- Keep messages short. Use bullet points. Bold key info with *asterisks*.`;
  } else if (category === 'conversational') {
    base += `\n\n## Rules
- Chat naturally. Be helpful, witty, concise.
- This is WhatsApp — keep it short.`;
  } else {
    base += `\n\n## Rules
- Use tools to answer questions. Do not guess — call the tool and report what it returns.
- For dates: compute relative dates from today. Use YYYY-MM-DD format. Use ISO 8601 for datetimes.
- UK train station CRS codes: KGX=Kings Cross, YRK=York, LDS=Leeds, EDB=Edinburgh, DAR=Darlington.

## Formatting tool results
- Report ONLY what the tool returned. Nothing more, nothing less.
- Use the EXACT titles, dates, times, and locations from the tool result.
- Do NOT add commentary, notes, warnings, or editorial observations about the data.
- Do NOT add suggestions or follow-up questions unless directly relevant.
- Do NOT invent, embellish, or infer any information not present in the tool result.
- Do NOT describe events as "continuing" or "recurring" unless the tool result explicitly says so.
- If an event spans multiple days, state the start and end date/time once — do not list it on each day.
- Keep messages short. Use bullet points. Bold key info with *asterisks*.
- This is WhatsApp — not an essay.`;
  }

  base += `\n\n## Memories
You may have background knowledge about James injected below. Use it to understand context (e.g. preferences, people, places) but do NOT mix memory facts into tool result summaries. Memories inform your understanding — tool results are the data you report.`;

  return base;
}

// Full tool-calling response via EVO X2's qwen3.5:35b
// Handles tool selection, execution, and final response generation
export async function getEvoToolResponse(context, tools, senderJid, memoryFragment = '', category = null) {
  const evoOllamaUrl = config.evoMemoryUrl.replace(':5100', ':11434');
  const ollamaTools = toOllamaTools(tools);

  const systemPrompt = buildEvoSystemPrompt(category) + memoryFragment;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: context },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    let res = await fetch(`${evoOllamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.evoToolModel,
        messages,
        tools: ollamaTools,
        stream: false,
        think: false,
        keep_alive: -1,
        options: { temperature: 0.3 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`EVO Ollama HTTP ${res.status}`);

    let data = await res.json();
    let msg = data.message || {};

    // Tool use loop
    let loopCount = 0;
    const maxLoops = 5;

    while (msg.tool_calls && msg.tool_calls.length > 0 && loopCount < maxLoops) {
      loopCount++;
      messages.push({ role: 'assistant', ...msg });

      const toolResults = [];
      const MAX_TOOL_RESULT = 1500;

      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        const toolName = fn.name;
        const toolInput = fn.arguments || {};

        logger.info({ tool: toolName, input: toolInput, source: 'evo' }, 'local tool call');
        let result = await executeTool(toolName, toolInput, senderJid);
        logger.info({ tool: toolName, chars: result.length, source: 'evo' }, 'local tool result');

        if (result.length > MAX_TOOL_RESULT) {
          result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
        }
        toolResults.push({ role: 'tool', content: result });
      }

      // Send tool results back for final response
      messages.push(...toolResults);

      const loopController = new AbortController();
      const loopTimeout = setTimeout(() => loopController.abort(), 60000);

      res = await fetch(`${evoOllamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.evoToolModel,
          messages,
          tools: ollamaTools,
          stream: false,
          think: false,
          keep_alive: -1,
          options: { temperature: 0.3 },
        }),
        signal: loopController.signal,
      });

      clearTimeout(loopTimeout);
      if (!res.ok) break;

      data = await res.json();
      msg = data.message || {};
      logger.info({ loop: loopCount, source: 'evo' }, 'tool loop');
    }

    const content = msg.content;
    if (!content) return null;

    logger.info({
      model: config.evoToolModel,
      chars: content.length,
      toolLoops: loopCount,
      evalMs: data.eval_duration ? Math.round(data.eval_duration / 1e6) : null,
    }, 'evo tool response');

    return content;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      logger.warn({ timeout: 60000 }, 'evo tool call timed out');
      return null;
    }
    logger.warn({ err: err.message }, 'evo tool call failed');
    return null;
  }
}

// Keep EVO X2 model loaded in VRAM (call periodically to prevent eviction)
export async function keepEvoModelWarm() {
  const evoOllamaUrl = config.evoMemoryUrl.replace(':5100', ':11434');
  try {
    const res = await fetch(`${evoOllamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.evoToolModel, prompt: '', keep_alive: -1 }),
    });
    if (res.ok) {
      logger.info({ model: config.evoToolModel }, 'evo model kept warm');
    }
  } catch {
    // EVO offline — ignore
  }
}

// Check if EVO X2's Ollama is reachable and has the tool model
export async function checkEvoOllamaHealth() {
  const evoOllamaUrl = config.evoMemoryUrl.replace(':5100', ':11434');
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${evoOllamaUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return models.some((m) => m.startsWith(config.evoToolModel.split(':')[0]));
  } catch {
    return false;
  }
}
