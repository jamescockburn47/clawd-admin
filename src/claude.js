import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { getSystemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { executeTool } from './tools/handler.js';
import { getEvoToolResponse, checkEvoHealth } from './evo-llm.js';
import { classifyMessage, getToolsForCategory, needsMemories, mustUseClaude, CATEGORY } from './router.js';
import { getRelevantMemories, formatMemoriesForPrompt, analyseImage, isEvoOnline } from './memory.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRouting } from './router-telemetry.js';
import { getLiveSystemSnapshot } from './system-knowledge.js';
import logger from './logger.js';

const claudeBreaker = new CircuitBreaker('claude', { threshold: 3, resetTimeout: 30000 });

const client = new Anthropic({ apiKey: config.anthropicApiKey });

let dailyCalls = 0;
let dailyResetDate = new Date().toDateString();

// Pricing per million tokens — keyed by model prefix
const MODEL_PRICING = {
  'claude-sonnet-4': { input: 3.00, output: 15.00, cache_write: 3.75, cache_read: 0.30 },
  'claude-haiku-4': { input: 0.80, output: 4.00, cache_write: 1.00, cache_read: 0.08 },
  'claude-opus-4': { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
};

function getPricing() {
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (config.claudeModel.startsWith(prefix)) return pricing;
  }
  return MODEL_PRICING['claude-sonnet-4'];
}

// Persistent usage file
const USAGE_FILE = join(config.authStatePath, 'usage.json');

function emptyBucket() {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, calls: 0 };
}

function loadUsage() {
  try {
    const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
    if (!('cache_write' in data.today)) {
      data.today.cache_write = 0;
      data.today.cache_read = 0;
      data.total.cache_write = 0;
      data.total.cache_read = 0;
    }
    return data;
  } catch (_) {
    return {
      today: { ...emptyBucket(), date: new Date().toDateString() },
      total: { ...emptyBucket(), since: new Date().toISOString() },
    };
  }
}

const usage = loadUsage();

let saveTimer = null;

function saveUsage() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) {}
    saveTimer = null;
  }, 10000);
}

export function flushUsage() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try { writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) {}
}

function trackTokens(response) {
  const u = response.usage || {};
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;

  const today = new Date().toDateString();
  if (today !== usage.today.date) {
    usage.today = { ...emptyBucket(), date: today };
  }

  usage.today.input += inp;
  usage.today.output += out;
  usage.today.cache_write += cw;
  usage.today.cache_read += cr;
  usage.total.input += inp;
  usage.total.output += out;
  usage.total.cache_write += cw;
  usage.total.cache_read += cr;
  saveUsage();
}

function calcCost(bucket) {
  const p = getPricing();
  return (bucket.input / 1_000_000) * p.input
    + (bucket.output / 1_000_000) * p.output
    + ((bucket.cache_write || 0) / 1_000_000) * p.cache_write
    + ((bucket.cache_read || 0) / 1_000_000) * p.cache_read;
}

export function getUsageStats() {
  const today = new Date().toDateString();
  if (today !== usage.today.date) {
    usage.today = { ...emptyBucket(), date: today };
  }
  return {
    today: { ...usage.today, cost: calcCost(usage.today) },
    total: { ...usage.total, cost: calcCost(usage.total) },
    model: config.claudeModel,
    dailyLimit: config.dailyCallLimit,
    pricing: getPricing(),
  };
}

function checkDailyLimit() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyCalls = 0;
    dailyResetDate = today;
  }
  return dailyCalls < config.dailyCallLimit;
}

// Tools restricted to owner only
const OWNER_ONLY_TOOLS = new Set([
  'gmail_search', 'gmail_read', 'gmail_draft', 'gmail_confirm_send',
  'soul_propose', 'soul_confirm',
  'calendar_create_event', 'calendar_update_event',
]);

function getAvailableTools(isOwner = true) {
  const hasGoogle = config.googleClientId && config.googleRefreshToken;
  const hasDarwin = !!config.darwinToken;
  const hasAmadeus = config.amadeusClientId && config.amadeusClientSecret;
  const hasBrave = !!config.braveApiKey;

  return TOOL_DEFINITIONS.filter((t) => {
    if (!isOwner && OWNER_ONLY_TOOLS.has(t.name)) return false;
    if (t.name.startsWith('calendar_') || t.name.startsWith('gmail_')) return hasGoogle;
    if (t.name === 'train_departures') return hasDarwin;
    if (t.name === 'hotel_search') return hasAmadeus;
    if (t.name === 'web_search') return hasBrave;
    return true;
  });
}

export async function getClawdResponse(context, mode, senderJid, imageData = null) {
  if (!checkDailyLimit()) {
    logger.warn({ limit: config.dailyCallLimit }, 'daily limit reached');
    return null;
  }

  const ownerJids = new Set();
  if (config.ownerJid) ownerJids.add(config.ownerJid);
  if (config.ownerLid) ownerJids.add(config.ownerLid);
  const isOwner = !senderJid || ownerJids.size === 0 || ownerJids.has(senderJid);
  const tools = getAvailableTools(isOwner);

  // --- Smart activity-based routing ---
  const routeStart = Date.now();
  const route = await classifyMessage(context, !!imageData);
  const { category, source: classifySource, forceClaude, reason: routeReason } = route;
  logger.info({ category, source: classifySource, forceClaude, reason: routeReason, sender: senderJid }, 'routed');

  // Filter tools for this category
  const categoryTools = getToolsForCategory(category, tools);

  // Conditional memory fetch
  let memoryFragment = '';
  if (config.evoMemoryEnabled && needsMemories(category)) {
    try {
      const memories = await getRelevantMemories(context);
      memoryFragment = formatMemoriesForPrompt(memories);
      if (memories.length > 0) {
        logger.info({ count: memories.length, category }, 'memories injected');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'memory fetch failed');
    }
  }

  // For SYSTEM queries: inject live status snapshot alongside stored knowledge
  if (category === CATEGORY.SYSTEM) {
    try {
      const liveSnapshot = await getLiveSystemSnapshot();
      memoryFragment += liveSnapshot;
    } catch (err) {
      logger.warn({ err: err.message }, 'live snapshot failed');
    }
  }

  // Try EVO X2 for non-forced-Claude categories
  if (!forceClaude && config.evoToolEnabled && mode !== 'random' && !imageData) {
    try {
      const evoAvailable = await checkEvoHealth();
      if (evoAvailable) {
        const evoStart = Date.now();
        const evoResponse = await getEvoToolResponse(context, categoryTools, senderJid, memoryFragment, category);
        if (evoResponse) {
          logRouting({
            category, confidence: null, model: 'local',
            latencyMs: Date.now() - evoStart, fallback: false,
            reason: classifySource, toolsCalled: [], text: context,
          });
          logger.info({ source: 'evo', category, chars: evoResponse.length }, 'responded via EVO X2');
          return evoResponse;
        }
        logger.warn('evo tool response was empty, falling back to Claude');
        logRouting({
          category, confidence: null, model: 'claude',
          latencyMs: Date.now() - evoStart, fallback: true,
          reason: 'evo empty response', toolsCalled: [], text: context,
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'evo tool call failed, falling back to Claude');
      logRouting({
        category, confidence: null, model: 'claude',
        latencyMs: Date.now() - routeStart, fallback: true,
        reason: `evo error: ${err.message}`, toolsCalled: [], text: context,
      });
    }
  }

  try {
    dailyCalls++;

    // For Claude fallback from EVO categories, use full tools. For Claude-native categories, use category tools.
    const claudeTools = mustUseClaude(category) ? categoryTools : tools;
    const cachedTools = claudeTools.map((t, i) =>
      i === claudeTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
    );

    const system = [
      { type: 'text', text: getSystemPrompt(mode, isOwner) + memoryFragment, cache_control: { type: 'ephemeral' } },
    ];

    // Build user message content — supports text + optional image
    const userContent = [];
    if (imageData) {
      // Try EVO X2 local vision first to save Claude vision tokens
      if (config.evoMemoryEnabled && isEvoOnline()) {
        try {
          const imgBuffer = Buffer.from(imageData.source.data, 'base64');
          const prompt = context || 'Describe this image in detail. Extract any text, numbers, names, dates visible.';
          const result = await analyseImage(imgBuffer, prompt);
          if (result && result.description) {
            // Use local analysis as text instead of sending image to Claude
            userContent.push({ type: 'text', text: `The user sent a photo. Here is a detailed description of what the photo contains (analysed locally):\n\n${result.description}` });
            logger.info({ chars: result.description.length }, 'image analysed locally via EVO X2');
          } else {
            // Local analysis returned null — fall back to Claude vision
            userContent.push(imageData);
            logger.info('EVO X2 image analysis returned null, falling back to Claude vision');
          }
        } catch (err) {
          // EVO X2 failed — fall back to Claude vision
          userContent.push(imageData);
          logger.warn({ err: err.message }, 'EVO X2 image analysis failed, falling back to Claude vision');
        }
      } else {
        // EVO offline or disabled — use Claude vision
        userContent.push(imageData);
      }
    }
    userContent.push({ type: 'text', text: context });

    const messages = [{ role: 'user', content: userContent }];

    let response = await claudeBreaker.call(
      () => client.messages.create({
        model: config.claudeModel,
        max_tokens: config.maxResponseTokens,
        system,
        messages,
        ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
      }),
      null,
    );

    if (!response) {
      return 'Claude API is temporarily unavailable. Try again shortly.';
    }

    trackTokens(response);
    usage.today.calls = dailyCalls;
    usage.total.calls++;
    const cacheInfo = response.usage?.cache_read_input_tokens ? ` (cache: ${response.usage.cache_read_input_tokens})` : '';
    logger.info({
      input: response.usage?.input_tokens,
      output: response.usage?.output_tokens,
      calls: `${dailyCalls}/${config.dailyCallLimit}`,
      hasImage: !!imageData,
    }, `claude response${cacheInfo}`);

    // Tool use loop
    let loopCount = 0;
    const maxLoops = 5;

    while (response.stop_reason === 'tool_use' && loopCount < maxLoops) {
      loopCount++;
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      const MAX_TOOL_RESULT = 1500;
      for (const toolUse of toolUseBlocks) {
        logger.info({ tool: toolUse.name, input: toolUse.input }, 'tool call');
        let result = await executeTool(toolUse.name, toolUse.input, senderJid);
        logger.info({ tool: toolUse.name, chars: result.length }, 'tool result');
        if (result.length > MAX_TOOL_RESULT) {
          result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      response = await claudeBreaker.call(
        () => client.messages.create({
          model: config.claudeModel,
          max_tokens: config.maxResponseTokens,
          system,
          messages,
          ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
        }),
        null,
      );

      if (!response) break; // Circuit open — exit tool loop
      trackTokens(response);
      logger.info({ loop: loopCount, input: response.usage?.input_tokens, output: response.usage?.output_tokens }, 'tool loop');
    }

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const text = textBlocks.map((b) => b.text).join('\n');

    if (!text) return null;

    logRouting({
      category, confidence: null, model: 'claude',
      latencyMs: Date.now() - routeStart,
      fallback: !forceClaude && config.evoToolEnabled,
      reason: routeReason || classifySource,
      toolsCalled: [], text: context,
    });

    return text;
  } catch (err) {
    const status = err?.status;
    if (status === 429) {
      logger.error({ status }, 'rate limited');
      return 'Hit the API rate limit. Try again in a moment.';
    }
    if (status === 529) {
      logger.error({ status }, 'API overloaded');
      return 'Claude API is overloaded. Try again shortly.';
    }
    logger.error({ err: err.message, status }, 'API error');
    return null;
  }
}
