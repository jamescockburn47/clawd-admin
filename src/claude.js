import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { getSystemPrompt } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { executeTool } from './tools/handler.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

let dailyCalls = 0;
let dailyResetDate = new Date().toDateString();

// Pricing per million tokens — keyed by model prefix
// cache_write = 1.25x input, cache_read = 0.1x input
const MODEL_PRICING = {
  'claude-sonnet-4': { input: 3.00, output: 15.00, cache_write: 3.75, cache_read: 0.30 },
  'claude-haiku-4': { input: 0.80, output: 4.00, cache_write: 1.00, cache_read: 0.08 },
  'claude-opus-4': { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
};

function getPricing() {
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (config.claudeModel.startsWith(prefix)) return pricing;
  }
  return MODEL_PRICING['claude-sonnet-4']; // fallback
}

// Persistent usage file
const USAGE_FILE = join(config.authStatePath, 'usage.json');

function emptyBucket() {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, calls: 0 };
}

function loadUsage() {
  try {
    const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
    // Migrate old format (no cache fields)
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
  // Debounce writes — save at most once every 10 seconds
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) {}
    saveTimer = null;
  }, 10000);
}

function trackTokens(response) {
  const u = response.usage || {};
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;

  // Reset daily if new day
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
  // Reset daily if stale
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

// Tools restricted to owner (James) only — not available to other group members
const OWNER_ONLY_TOOLS = new Set([
  'gmail_search', 'gmail_read', 'gmail_draft', 'gmail_confirm_send',
  'soul_propose', 'soul_confirm',
  'calendar_create_event', 'calendar_update_event',
]);

// Build available tools based on configured credentials and sender permissions
function getAvailableTools(isOwner = true) {
  const hasGoogle = config.googleClientId && config.googleRefreshToken;
  const hasDarwin = !!config.darwinToken;
  const hasAmadeus = config.amadeusClientId && config.amadeusClientSecret;
  const hasBrave = !!config.braveApiKey;

  return TOOL_DEFINITIONS.filter((t) => {
    // Owner-only tools blocked for non-owner senders
    if (!isOwner && OWNER_ONLY_TOOLS.has(t.name)) return false;
    // Google tools need credentials
    if (t.name.startsWith('calendar_') || t.name.startsWith('gmail_')) {
      return hasGoogle;
    }
    // Darwin needs a token
    if (t.name === 'train_departures') return hasDarwin;
    // Amadeus needs credentials
    if (t.name === 'hotel_search') return hasAmadeus;
    // Brave Search needs API key
    if (t.name === 'web_search') return hasBrave;
    // BR Fares (train_fares) is open — no key needed
    // Travel URL builders, soul tools always available
    return true;
  });
}

export async function getClawdResponse(context, mode, senderJid) {
  if (!checkDailyLimit()) {
    console.log(`[claude] Daily limit reached (${config.dailyCallLimit}). Ignoring.`);
    return null;
  }

  try {
    dailyCalls++;
    // Check both phone JID (@s.whatsapp.net) and LID (@lid) formats
    const ownerJids = new Set();
    if (config.ownerJid) ownerJids.add(config.ownerJid);
    if (config.ownerLid) ownerJids.add(config.ownerLid);
    const isOwner = !senderJid || ownerJids.size === 0 || ownerJids.has(senderJid);
    const tools = getAvailableTools(isOwner);

    // Mark last tool for prompt caching (system prompt + tools = stable prefix)
    const cachedTools = tools.map((t, i) =>
      i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
    );

    // System prompt as cacheable content block
    const system = [
      { type: 'text', text: getSystemPrompt(mode, isOwner), cache_control: { type: 'ephemeral' } },
    ];

    const messages = [{ role: 'user', content: context }];

    // Initial API call with tools
    let response = await client.messages.create({
      model: config.claudeModel,
      max_tokens: config.maxResponseTokens,
      system,
      messages,
      ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
    });

    trackTokens(response);
    usage.today.calls = dailyCalls;
    usage.total.calls++;
    const cacheInfo = response.usage?.cache_read_input_tokens ? ` (cache hit: ${response.usage.cache_read_input_tokens} tokens)` : '';
    console.log(`[claude] Tokens — input: ${response.usage?.input_tokens}, output: ${response.usage?.output_tokens}${cacheInfo} | Calls today: ${dailyCalls}/${config.dailyCallLimit}`);

    // Tool use loop — keep going while Claude wants to use tools
    let loopCount = 0;
    const maxLoops = 5;

    while (response.stop_reason === 'tool_use' && loopCount < maxLoops) {
      loopCount++;

      // Collect all tool_use blocks from the response
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) break;

      // Add assistant message to conversation
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool and build tool_result blocks
      const toolResults = [];
      const MAX_TOOL_RESULT = 1500;
      for (const toolUse of toolUseBlocks) {
        console.log(`[tool] Calling ${toolUse.name} with:`, JSON.stringify(toolUse.input));
        let result = await executeTool(toolUse.name, toolUse.input);
        console.log(`[tool] ${toolUse.name} returned ${result.length} chars`);
        if (result.length > MAX_TOOL_RESULT) {
          result = result.slice(0, MAX_TOOL_RESULT) + '\n[...truncated]';
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // Add tool results to conversation
      messages.push({ role: 'user', content: toolResults });

      // Call Claude again with the tool results
      response = await client.messages.create({
        model: config.claudeModel,
        max_tokens: config.maxResponseTokens,
        system,
        messages,
        ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
      });

      trackTokens(response);
      console.log(`[claude] Loop ${loopCount} — input: ${response.usage?.input_tokens}, output: ${response.usage?.output_tokens}`);
    }

    // Extract final text response
    const textBlocks = response.content.filter((b) => b.type === 'text');
    const text = textBlocks.map((b) => b.text).join('\n');

    if (!text) return null;
    return text;
  } catch (err) {
    const status = err?.status;
    if (status === 429) {
      console.error(`[claude] Rate limited: ${err.message}`);
      return 'Hit the API rate limit. Try again in a moment.';
    }
    if (status === 529) {
      console.error(`[claude] Overloaded: ${err.message}`);
      return 'Claude API is overloaded. Try again shortly.';
    }
    console.error(`[claude] API error: ${err.message}`);
    return null;
  }
}
