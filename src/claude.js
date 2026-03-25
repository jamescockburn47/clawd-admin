import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { getSystemPrompt, isProfessionalGroup } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { executeTool } from './tools/handler.js';
import { getEvoToolResponse, checkEvoHealth } from './evo-llm.js';
import { classifyMessage, getToolsForCategory, needsMemories, mustUseClaude, CATEGORY } from './router.js';
import { getRelevantMemories, formatMemoriesForPrompt, analyseImage, isEvoOnline, getDreamMemories, getIdentityMemories, getInsightMemories, searchMemory } from './memory.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRouting } from './router-telemetry.js';
import { getWorkingKnowledge, warmFromQuery } from './lquorum-rag.js';
import { getLiveSystemSnapshot } from './system-knowledge.js';
import logger from './logger.js';

const claudeBreaker = new CircuitBreaker('claude', { threshold: 3, resetTimeout: 30000 });

let _lastToolsCalled = [];
export function getLastToolsCalled() { return _lastToolsCalled; }

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
  'soul_propose', 'soul_confirm', 'soul_learn', 'soul_forget',
  'calendar_create_event', 'calendar_update_event',
  'evolution_task',
]);

function getAvailableTools(isOwner = true) {
  const hasGoogle = config.googleClientId && config.googleRefreshToken;
  const hasDarwin = !!config.darwinToken;
  const hasAmadeus = config.amadeusClientId && config.amadeusClientSecret;
  return TOOL_DEFINITIONS.filter((t) => {
    if (!isOwner && OWNER_ONLY_TOOLS.has(t.name)) return false;
    if (t.name.startsWith('calendar_') || t.name.startsWith('gmail_')) return hasGoogle;
    if (t.name === 'train_departures') return hasDarwin;
    if (t.name === 'hotel_search') return hasAmadeus;
    // web_search always available via SearXNG (self-hosted, no key needed)
    return true;
  });
}

export async function getClawdResponse(context, mode, senderJid, imageData = null, chatJid = null) {
  _lastToolsCalled = [];

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
  const isGroup = chatJid && chatJid.endsWith('@g.us');
  const route = await classifyMessage(context, !!imageData, isGroup);
  const { category, source: classifySource, forceClaude, reason: routeReason } = route;
  logger.info({ category, source: classifySource, forceClaude, reason: routeReason, sender: senderJid }, 'routed');

  // Filter tools for this category
  const categoryTools = getToolsForCategory(category, tools);

  // Conditional memory fetch
  const professional = isProfessionalGroup(chatJid);
  const PERSONAL_MEMORY_CATEGORIES = new Set(['henry', 'travel', 'accommodation', 'schedule']);

  let memoryFragment = '';
  if (config.evoMemoryEnabled && needsMemories(category)) {
    try {
      let memories = await getRelevantMemories(context);
      // Filter personal memories in professional groups
      if (professional) {
        memories = memories.filter(m => !PERSONAL_MEMORY_CATEGORIES.has(m.category));
      }
      memoryFragment = formatMemoriesForPrompt(memories);
      if (memories.length > 0) {
        logger.info({ count: memories.length, category, filtered: professional }, 'memories injected');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'memory fetch failed');
    }
  }

  // Identity memories — always inject (these are about Clawd, not personal)
  if (config.evoMemoryEnabled) {
    try {
      const identityMems = await getIdentityMemories();
      if (identityMems.length > 0) {
        const idLines = identityMems.map(m => `- ${m.fact}`).join('\n');
        memoryFragment += `\n\n## Who I am\n${idLines}`;
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'identity memory fetch failed');
    }
  }

  // Dream memories — skip in professional groups (may contain personal content)
  if (config.evoMemoryEnabled && config.dreamModeEnabled && !professional) {
    try {
      // If user explicitly asked about dreams/diary, do a deeper fetch
      const isDreamQuery = /\b(dream|diary|dreamt|dreamed|last night|overnight)\b/i.test(context);
      const dreamLimit = isDreamQuery ? 5 : 2;
      // Use yesterday's date as search hint for better recall
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const dreamQuery = isDreamQuery ? `dream diary ${yesterday}` : 'dream summary recent';
      const dreams = await searchMemory(dreamQuery, 'dream', dreamLimit);
      const dreamMems = dreams.map(r => r.memory || r).filter(Boolean);
      if (dreamMems.length > 0) {
        const dreamLines = dreamMems.map(d => `- ${d.fact}`).join('\n');
        const header = isDreamQuery
          ? '## My diary entries (dream mode summaries)'
          : '## Recent experiences (dream summaries)';
        memoryFragment += `\n\n${header}\n${dreamLines}`;
        logger.info({ count: dreamMems.length, explicit: isDreamQuery }, 'dream memories injected');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'dream memory injection failed');
    }
  }

  // Inject lquorum working memory (pre-staged topic knowledge)
  // Warm working memory from the direct query (no length filter)
  warmFromQuery(context);
  const lquorumContext = getWorkingKnowledge();
  if (lquorumContext) {
    memoryFragment += '\n\n' + lquorumContext;
    logger.info({ topics: lquorumContext.split('###').length - 1 }, 'lquorum working knowledge injected');
  }

  // Insight memories — topic-matched diary insights for conversational context
  if (config.evoMemoryEnabled && !professional) {
    try {
      const insights = await getInsightMemories(context, 3);
      if (insights.length > 0) {
        const insightLines = insights.map(m => `- ${m.fact}`).join('\n');
        memoryFragment += `\n\n## Prior insights\n${insightLines}`;
        logger.info({ count: insights.length }, 'diary insights injected');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'insight memory injection failed');
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

  // Try EVO X2 for non-forced-Claude categories (now supports images via VL model)
  if (!forceClaude && config.evoToolEnabled && mode !== 'random') {
    try {
      const evoAvailable = await checkEvoHealth();
      if (evoAvailable) {
        const evoStart = Date.now();
        const evoResponse = await getEvoToolResponse(context, categoryTools, senderJid, memoryFragment, category, imageData);
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
      { type: 'text', text: getSystemPrompt(mode, isOwner, isGroup, category, chatJid) + memoryFragment, cache_control: { type: 'ephemeral' } },
    ];

    // Build user message content — supports text + optional image
    // If we're here with an image, EVO VL already failed/was offline — send direct to Claude
    const userContent = [];
    if (imageData) {
      userContent.push(imageData);
      logger.info('image sent to Claude vision (EVO VL unavailable or failed)');
    }
    userContent.push({ type: 'text', text: context });

    const messages = [{ role: 'user', content: userContent }];

    let response = await claudeBreaker.call(
      () => client.messages.create({
        model: config.claudeModel,
        max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
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
        _lastToolsCalled.push(toolUse.name);
        let result = await executeTool(toolUse.name, toolUse.input, senderJid, chatJid);
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
          max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
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
    let text = textBlocks.map((b) => b.text).join('\n');

    if (!text) return null;

    // --- Self-critique pass (Opus 4.6) ---
    // Fires selectively on high-value responses where quality matters.
    // Not every message — only strategic/project/planning content that's substantial.
    const shouldCritique = (
      category === CATEGORY.PLANNING
      && text.length > 200
      && !text.startsWith('Learned:')      // skip soul confirmations
      && !text.startsWith('Updated ')      // skip project updates
      && !text.startsWith('No pending')    // skip mechanical responses
    );

    if (shouldCritique) {
      try {
        const critiqueModel = process.env.CRITIQUE_MODEL || 'claude-opus-4-6';
        logger.info({ category, responseLen: text.length, model: critiqueModel }, 'self-critique: reviewing response');

        const critiqueResponse = await client.messages.create({
          model: critiqueModel,
          max_tokens: config.maxResponseTokens * 4,
          system: `You are a ruthless quality gate. You review Clawd's draft responses before they're sent to a WhatsApp group of sharp, critical people who will instantly spot AI slop.

REJECT and rewrite if ANY of these are present:

STRUCTURAL SLOP:
- 4+ bullet points or numbered items. Condense to the 2-3 that matter and explain them in prose.
- "8 things" / "5 phases" / "10 gaps" — identify the ONE that matters and explain why.
- Inventorying: "Here's what exists: [list]" — never insightful. Instead: what most people miss and why.
- Binary contrasts: "It's not X. It's Y." — state the point directly.
- Dramatic fragments: "[Noun]. That's it." — write a real sentence.
- Rhetorical questions answered immediately — delete the question, keep the answer.

LANGUAGE SLOP:
- Any of: "Here's the thing", "It's worth noting", "Let me be clear", "Moreover", "Furthermore", "Indeed", "At the end of the day", "Full stop.", "Great question!", "Absolutely!"
- Adverbs: really, just, literally, genuinely, honestly, simply, actually, deeply, truly, fundamentally, inherently, inevitably
- Business jargon: navigate, lean into, landscape, game-changer, double down, deep dive, leverage, unlock, harness, supercharge, robust, seamless
- Em dash overuse — max one per message
- False agency: "the data tells us" — name the person

SUBSTANCE SLOP:
- Truisms: "communication is key", "quality matters", "there are no easy answers"
- Sentences that restate what was already said or what's obvious from context
- Generic answers that would be equally true of any similar question
- Paragraphs that fail the "so what?" test — if a reader could say "okay, and?" it's too shallow

Every sentence must add information the reader did not already have. Density over length. Reasoning over coverage.

OUTPUT RULES:
- If the draft passes all checks, return [APPROVED] at the start.
- If rewriting, output ONLY the replacement text. No preamble, no critique, no explanation, no tags. The reader must never know a review happened.
- Default to rewriting. Be very hard to impress.`,
          messages: [{ role: 'user', content: `DRAFT RESPONSE TO REVIEW:\n\n${text}` }],
        });

        trackTokens(critiqueResponse);
        let critiqueText = critiqueResponse.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('\n')
          .trim();

        if (critiqueText.startsWith('[APPROVED]')) {
          logger.info('self-critique: approved as-is');
        } else if (critiqueText.length > 50) {
          // Post-process: strip any leaked critique artifacts.
          // Strategy: if there's a --- separator in the first 500 chars, everything
          // before it is meta-commentary (critique preamble). Take everything after.
          const earlyDivider = critiqueText.slice(0, 500).match(/\n---\s*\n/);
          if (earlyDivider) {
            const afterDivider = critiqueText.slice(earlyDivider.index + earlyDivider[0].length).trim();
            if (afterDivider.length > 50) {
              critiqueText = afterDivider;
            }
          }

          // Strip leading meta-commentary that doesn't use --- divider
          critiqueText = critiqueText
            .replace(/^\*?REWRITE:?\*?\s*\n*/i, '')
            .replace(/^(?:This is|Let me|I'll|Here's the|The draft).+?\.\s*\n+/i, '')
            .trim();

          // Strip trailing meta-commentary and tags
          critiqueText = critiqueText
            .replace(/\n+---\s*\n+[\s\S]*$/i, '')
            .replace(/\s*\[(?:REWRITTEN|REVISED|APPROVED)\]\s*$/i, '')
            .replace(/\s*---\s*$/i, '')
            .trim();

          if (critiqueText.length > 50) {
            text = critiqueText;
            logger.info({ originalLen: text.length, revisedLen: critiqueText.length }, 'self-critique: response refined by Opus');
          }
        }
      } catch (err) {
        // Critique failed — send the original (don't block the response)
        logger.warn({ err: err.message }, 'self-critique: failed, sending original');
      }
    }

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
