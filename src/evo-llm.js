// EVO X2 local model integration via llama.cpp (OpenAI-compatible API)
// Handles tool calling and response generation locally, falling back to Claude
import config from './config.js';
import logger from './logger.js';
import { executeTool } from './tools/handler.js';
import { getWorkingKnowledge, warmFromQuery } from './lquorum-rag.js';

// Convert Anthropic-style tool definitions to OpenAI function-calling format
function toOpenAITools(tools) {
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

// Validate tool call parameters before executing — local models can hallucinate args
function validateToolParams(toolName, params) {
  if (!params || typeof params !== 'object') return 'missing or invalid parameters';

  const dateFields = ['date', 'startDate', 'endDate', 'start_date', 'end_date', 'due_date', 'dueDate'];
  for (const field of dateFields) {
    if (params[field] && typeof params[field] === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}/.test(params[field])) {
        return `invalid date format for ${field}: ${params[field]}`;
      }
    }
  }

  const required = {
    'calendar_create_event': ['summary', 'start'],
    'todo_add': ['text'],
    'gmail_draft': ['to', 'subject'],
    'train_departures': ['from', 'to'],
    'memory_search': ['query'],
    'web_search': ['query'],
  };
  const reqs = required[toolName];
  if (reqs) {
    for (const r of reqs) {
      if (!params[r]) return `missing required parameter: ${r}`;
    }
  }

  return null;
}

// Full tool-calling response via EVO X2's llama-server (OpenAI-compatible API)
export async function getEvoToolResponse(context, tools, senderJid, memoryFragment = '', category = null, imageData = null) {
  const baseUrl = config.evoLlmUrl;
  const openAITools = toOpenAITools(tools);
  warmFromQuery(context);
  const lquorumContext = getWorkingKnowledge();
  const systemPrompt = buildEvoSystemPrompt(category) + memoryFragment + (lquorumContext ? '\n\n' + lquorumContext : '');

  // Build user content — text or text + image for VL model
  let userContent;
  const isVisionQuery = !!imageData;
  if (imageData) {
    const base64 = imageData.source?.data || (Buffer.isBuffer(imageData) ? imageData.toString('base64') : null);
    const mediaType = imageData.source?.media_type || 'image/jpeg';
    userContent = [
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
      { type: 'text', text: context || 'Describe this image in detail. Extract any text, numbers, names, dates visible.' },
    ];
    logger.info('sending image to EVO VL model');
  } else {
    userContent = context;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    let res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        // No tools for vision queries — model should respond directly about the image
        tools: (!isVisionQuery && openAITools.length > 0) ? openAITools : undefined,
        temperature: 0.3,
        max_tokens: isVisionQuery ? 2000 : 1000,
        cache_prompt: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => 'no body');
      logger.warn({ status: res.status, body: errBody.slice(0, 500), hasImage: !!imageData }, 'EVO llama-server error response');
      throw new Error(`EVO llama-server HTTP ${res.status}`);
    }

    let data = await res.json();
    let msg = data.choices?.[0]?.message || {};

    // Tool use loop
    let loopCount = 0;
    const maxLoops = 5;

    while (msg.tool_calls && msg.tool_calls.length > 0 && loopCount < maxLoops) {
      loopCount++;
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

      const MAX_TOOL_RESULT = 1500;

      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        const toolName = fn.name;
        let toolInput;
        try {
          toolInput = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {};
        } catch {
          toolInput = {};
        }

        const validationError = validateToolParams(toolName, toolInput);
        if (validationError) {
          logger.warn({ tool: toolName, error: validationError, source: 'evo' }, 'tool params rejected');
          messages.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${validationError}. Please fix and try again.` });
          continue;
        }

        logger.info({ tool: toolName, input: toolInput, source: 'evo' }, 'local tool call');
        let result = await executeTool(toolName, toolInput, senderJid);
        logger.info({ tool: toolName, chars: result.length, source: 'evo' }, 'local tool result');

        if (result.length > MAX_TOOL_RESULT) {
          result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }

      // Send tool results back for final response
      const loopController = new AbortController();
      const loopTimeout = setTimeout(() => loopController.abort(), 60000);

      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          tools: openAITools.length > 0 ? openAITools : undefined,
          temperature: 0.3,
          max_tokens: 1000,
          cache_prompt: true,
        }),
        signal: loopController.signal,
      });

      clearTimeout(loopTimeout);
      if (!res.ok) break;

      data = await res.json();
      msg = data.choices?.[0]?.message || {};
      logger.info({ loop: loopCount, source: 'evo' }, 'tool loop');
    }

    const content = msg.content;
    if (!content) return null;

    // Extract timing from llama-server response
    const timings = data.timings || data.usage || {};
    logger.info({
      model: data.model || 'evo-local',
      chars: content.length,
      toolLoops: loopCount,
      promptTokens: timings.prompt_tokens || data.usage?.prompt_tokens,
      completionTokens: timings.completion_tokens || data.usage?.completion_tokens,
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

// Check if EVO X2's llama-server is healthy
export async function checkEvoHealth() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${config.evoLlmUrl}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'ok' || data.status === 'no slot available';
  } catch {
    return false;
  }
}

// ── Granite-Docling structured document parsing ──────────────────────────────

const DOCLING_URL = (config.evoLlmUrl || 'http://10.0.0.2:8080').replace(/:8080$/, ':8084');

/**
 * Parse a PDF page image via Granite-Docling on EVO X2.
 * Takes a PNG/JPEG buffer of a rendered page, returns structured DocTags as text.
 */
async function parsePageViaDocling(imageBuffer) {
  const base64 = imageBuffer.toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${DOCLING_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            { type: 'text', text: 'Convert this document page to DocTags.' },
          ],
        }],
        temperature: 0.0,
        max_tokens: 4000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    clearTimeout(timeoutId);
    logger.warn({ err: err.message }, 'Granite-Docling page parse failed');
    return null;
  }
}

/**
 * Convert DocTags output to clean markdown.
 * DocTags format: <loc_x1><loc_y1><loc_x2><loc_y2>text content
 */
function docTagsToMarkdown(docTags) {
  if (!docTags) return null;

  // Strip location tags and extract text content
  let md = docTags
    .replace(/<loc_\d+>/g, '')
    .replace(/<otsl>/g, '')
    .replace(/<\/otsl>/g, '')
    .replace(/<fcel>/g, '| ')
    .replace(/<\/fcel>/g, ' ')
    .replace(/<ecel>/g, '| ')
    .replace(/<\/ecel>/g, ' ')
    .replace(/<nl>/g, '|\n')
    .replace(/<caption>/g, '*')
    .replace(/<\/caption>/g, '*')
    .replace(/<section-header[^>]*>/g, '## ')
    .replace(/<\/section-header>/g, '')
    .replace(/<title>/g, '# ')
    .replace(/<\/title>/g, '')
    .replace(/<text>/g, '')
    .replace(/<\/text>/g, '')
    .replace(/<list-item>/g, '- ')
    .replace(/<\/list-item>/g, '')
    .replace(/<table>/g, '')
    .replace(/<\/table>/g, '')
    .replace(/<figure>/g, '[Figure]')
    .replace(/<\/figure>/g, '')
    .replace(/<page_break>/g, '\n---\n')
    .replace(/<[^>]+>/g, '') // catch remaining tags
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return md || null;
}

/**
 * Parse a PDF via Granite-Docling: render pages to images, parse each, return structured markdown.
 * Requires pdftoppm on the Pi (poppler-utils).
 */
export async function parseDocumentWithDocling(pdfBuffer, fileName, maxPages = 10) {
  const { execSync } = await import('child_process');
  const { writeFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  const tmpDir = join('/tmp', `docling_${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const pdfPath = join(tmpDir, 'input.pdf');
  writeFileSync(pdfPath, pdfBuffer);

  try {
    // Render PDF pages to PNG images using pdftoppm
    execSync(`pdftoppm -png -r 200 -l ${maxPages} "${pdfPath}" "${join(tmpDir, 'page')}"`, { timeout: 30000 });

    const pageFiles = readdirSync(tmpDir)
      .filter(f => f.startsWith('page') && f.endsWith('.png'))
      .sort();

    if (pageFiles.length === 0) {
      logger.warn({ fileName }, 'pdftoppm produced no page images');
      return null;
    }

    logger.info({ fileName, pages: pageFiles.length }, 'rendering PDF pages for Docling');

    const allMarkdown = [];
    for (const pageFile of pageFiles) {
      const imgBuffer = readFileSync(join(tmpDir, pageFile));
      const docTags = await parsePageViaDocling(imgBuffer);
      const md = docTagsToMarkdown(docTags);
      if (md) allMarkdown.push(md);
    }

    // Cleanup
    for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f));
    try { execSync(`rmdir "${tmpDir}"`); } catch {}

    if (allMarkdown.length === 0) return null;

    const result = allMarkdown.join('\n\n---\n\n');
    logger.info({ fileName, pages: allMarkdown.length, chars: result.length }, 'PDF parsed via Granite-Docling');
    return result;
  } catch (err) {
    logger.warn({ err: err.message, fileName }, 'Granite-Docling PDF parsing failed');
    // Cleanup on error
    try {
      for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f));
      execSync(`rmdir "${tmpDir}"`);
    } catch {}
    return null;
  }
}

// Summarise document text via EVO X2 — saves Claude tokens
export async function summariseDocument(text, fileName, maxOutputTokens = 500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${config.evoLlmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a document summariser. Produce a concise but thorough summary preserving key facts, figures, names, dates, arguments, and conclusions. Do not add commentary or opinion. If the document has structure (sections, headings), preserve that structure in condensed form.' },
          { role: 'user', content: `Summarise this document (${fileName}):\n\n${text}` },
        ],
        temperature: 0.1,
        max_tokens: maxOutputTokens,
        cache_prompt: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      logger.warn({ status: res.status, fileName }, 'EVO document summarisation failed');
      return null;
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (summary) {
      logger.info({ fileName, inputChars: text.length, summaryChars: summary.length }, 'document summarised via EVO');
    }
    return summary || null;
  } catch (err) {
    clearTimeout(timeoutId);
    logger.warn({ err: err.message, fileName }, 'EVO document summarisation error');
    return null;
  }
}

// Classify message via EVO X2's classifier llama-server
export async function classifyViaEvo(text, systemPrompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${config.evoClassifierUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0,
        max_tokens: 10,
        cache_prompt: true,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!res.ok) return null;

    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Keep-alive ping — exercises inference path to prevent any idle-state degradation
export async function keepEvoWarm() {
  try {
    const res = await fetch(`${config.evoLlmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        cache_prompt: true,
      }),
    });
    if (res.ok) {
      logger.info('evo model kept warm');
    }
  } catch {
    // EVO offline — ignore
  }
}
