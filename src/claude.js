import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import { getSystemPrompt, isProfessionalGroup } from './prompt.js';
import { TOOL_DEFINITIONS } from './tools/definitions.js';
import { executeTool } from './tools/handler.js';
// EVO local model no longer used for chat — only classification, vision, doc summarisation
// import { getEvoToolResponse } from './evo-llm.js';
// import { checkLlamaHealth } from './evo-client.js';
import { classifyMessage, getToolsForCategory, needsMemories, mustUseClaude, CATEGORY } from './router.js';
import { getRelevantMemories, formatMemoriesForPrompt, analyseImage, isEvoOnline, getDreamMemories, getIdentityMemories, getInsightMemories, searchMemory } from './memory.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logRouting } from './router-telemetry.js';
import { logReasoningTrace } from './reasoning-trace.js';
import { getWorkingKnowledge, warmFromQuery } from './lquorum-rag.js';
import { PLANNING } from './constants.js';
import { getLiveSystemSnapshot } from './system-knowledge.js';
import { trackTokens, checkDailyLimit, incrementDailyCalls, getDailyCalls, recordCallInUsage, getUsageStats, flushUsage } from './usage-tracker.js';
import { shouldCritique, runCritique } from './quality-gate.js';
import logger from './logger.js';

// Re-export for backward compatibility
export { getUsageStats, flushUsage };

const claudeBreaker = new CircuitBreaker('claude', { threshold: 3, resetTimeout: 30000 });
const minimaxBreaker = new CircuitBreaker('minimax', { threshold: 3, resetTimeout: 30000 });

let _lastToolsCalled = [];
export function getLastToolsCalled() { return _lastToolsCalled; }

// Claude client — premium, used when explicitly requested or as fallback
const claudeClient = new Anthropic({ apiKey: config.anthropicApiKey });

// MiniMax client — default cloud model (Anthropic-compatible API)
const minimaxClient = config.minimaxApiKey
  ? new Anthropic({ apiKey: config.minimaxApiKey, baseURL: config.minimaxBaseUrl })
  : null;

// Default client and model — MiniMax if available, else Claude
const client = minimaxClient || claudeClient;
const defaultModel = minimaxClient ? config.minimaxModel : config.claudeModel;

// Detect explicit user request for Claude/Opus
const CLAUDE_REQUEST_PATTERNS = /\b(?:ask claude|use claude|use opus|ask opus|claude only|opus only)\b/i;

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
    return true;
  });
}

export async function getClawdResponse(context, mode, senderJid, imageData = null, chatJid = null, options = {}) {
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
  // Secretary mode (clawdsec): skip planner, single-tool admin only
  if (options.secretaryMode) {
    route.needsPlan = false;
    route.planReason = null;
    logger.info({ category: route.category }, 'secretary mode — planner bypassed');
  }
  const { category, source: classifySource, forceClaude, reason: routeReason } = route;

  // Detect explicit user request for Claude/Opus (overrides default MiniMax routing)
  const userWantsClaude = CLAUDE_REQUEST_PATTERNS.test(context);
  const useClaudeClient = userWantsClaude;
  const activeClient = useClaudeClient ? claudeClient : client;
  const activeModel = useClaudeClient ? config.claudeModel : defaultModel;

  logger.info({
    category, source: classifySource, forceClaude, reason: routeReason,
    sender: senderJid, model: activeModel, explicitClaude: userWantsClaude,
  }, 'routed');

  const categoryTools = getToolsForCategory(category, tools);

  // Group check — gates personal admin tools, NOT memories/dreams/insights
  const isGroupChat = isProfessionalGroup(chatJid);

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

  // Identity memories — always inject
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

  // Dream memories — always inject (part of Clawd's intelligence, not personal admin)
  if (config.evoMemoryEnabled && config.dreamModeEnabled) {
    try {
      const isDreamQuery = /\b(dream|diary|dreamt|dreamed|last night|overnight)\b/i.test(context);
      const dreamLimit = isDreamQuery ? 5 : 2;
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

  // Inject lquorum working memory
  warmFromQuery(context);
  const lquorumContext = getWorkingKnowledge();
  if (lquorumContext) {
    memoryFragment += '\n\n' + lquorumContext;
    logger.info({ topics: lquorumContext.split('###').length - 1 }, 'lquorum working knowledge injected');
  }

  // Insight memories — always inject
  if (config.evoMemoryEnabled) {
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

  // For SYSTEM queries: inject live status snapshot
  if (category === CATEGORY.SYSTEM) {
    try {
      const liveSnapshot = await getLiveSystemSnapshot();
      memoryFragment += liveSnapshot;
    } catch (err) {
      logger.warn({ err: err.message }, 'live snapshot failed');
    }
  }

  // --- Task planner: multi-step requests ---
  if (route.needsPlan && (route.confidence || 0) >= PLANNING.MIN_CONFIDENCE) {
    try {
      const { executePlan } = await import('./task-planner.js');
      const planResult = await executePlan(context, route, senderJid, chatJid, memoryFragment);
      if (planResult) {
        logReasoningTrace({
          chatId: chatJid, sender: senderJid, engagement: null,
          routing: {
            category, layer: classifySource, needsPlan: true,
            planReason: route.planReason, forceClaude,
            writeIntent: !!routeReason?.includes('write'),
            confidence: route.confidence, timeMs: Date.now() - routeStart,
          },
          model: { selected: 'evo-30b', reason: 'needsPlan', qualityGate: false },
          plan: planResult.plan,
          toolsCalled: planResult.plan.steps.map(s => s.tool),
          totalTimeMs: Date.now() - routeStart,
        });
        return planResult.response;
      }
      // Plan failed — fall through to single-shot
      logger.warn('task planner failed, falling back to single-shot');
    } catch (err) {
      logger.error({ err: err.message }, 'task planner error');
    }
  }

  // EVO X2 local model no longer used for chat responses — MiniMax handles all chat
  // with Opus quality gate on complex categories. EVO still does:
  // classification (0.6B + 4B), vision (VL), document summarisation, engagement.

  try {
    const dailyCalls = incrementDailyCalls();

    const claudeTools = mustUseClaude(category) ? categoryTools : tools;
    const cachedTools = claudeTools.map((t, i) =>
      i === claudeTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
    );

    const system = [
      { type: 'text', text: getSystemPrompt(mode, isOwner, isGroup, category, chatJid) + memoryFragment, cache_control: { type: 'ephemeral' } },
    ];

    const userContent = [];
    if (imageData) {
      userContent.push(imageData);
      logger.info('image sent to Claude vision (EVO VL unavailable or failed)');
    }
    userContent.push({ type: 'text', text: context });

    const messages = [{ role: 'user', content: userContent }];

    const breaker = useClaudeClient ? claudeBreaker : (minimaxClient ? minimaxBreaker : claudeBreaker);

    let response = await breaker.call(
      () => activeClient.messages.create({
        model: activeModel,
        max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
        system,
        messages,
        ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
      }),
      null,
    );

    // Fallback: if MiniMax failed and we weren't already using Claude, try Claude
    if (!response && !useClaudeClient && minimaxClient) {
      logger.warn('MiniMax unavailable, falling back to Claude');
      response = await claudeBreaker.call(
        () => claudeClient.messages.create({
          model: config.claudeModel,
          max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
          system,
          messages,
          ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
        }),
        null,
      );
    }

    if (!response) {
      return 'API is temporarily unavailable. Try again shortly.';
    }

    trackTokens(response);
    recordCallInUsage();
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

      response = await breaker.call(
        () => activeClient.messages.create({
          model: activeModel,
          max_tokens: (isGroup && mode === 'random') ? config.maxResponseTokens : config.maxResponseTokens * 4,
          system,
          messages,
          ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
        }),
        null,
      );

      if (!response) break;
      trackTokens(response);
      logger.info({ loop: loopCount, input: response.usage?.input_tokens, output: response.usage?.output_tokens }, 'tool loop');
    }

    const textBlocks = response.content.filter((b) => b.type === 'text');
    let text = textBlocks.map((b) => b.text).join('\n');

    if (!text) return null;

    // --- Quality gate pass (Opus 4.6) ---
    if (shouldCritique(category, text, useClaudeClient)) {
      text = await runCritique(text, category, trackTokens);
    }

    const selectedModel = useClaudeClient ? 'claude' : (minimaxClient ? 'minimax' : 'claude');
    logRouting({
      category, confidence: null, model: selectedModel,
      latencyMs: Date.now() - routeStart,
      fallback: !forceClaude && config.evoToolEnabled,
      reason: routeReason || classifySource,
      toolsCalled: _lastToolsCalled, text: context,
    });

    logReasoningTrace({
      chatId: chatJid, sender: senderJid, engagement: null,
      routing: {
        category, layer: classifySource,
        needsPlan: route.needsPlan || false,
        planReason: route.planReason || null,
        forceClaude,
        writeIntent: !!routeReason?.includes('write'),
        confidence: route.confidence || null,
        timeMs: Date.now() - routeStart,
      },
      model: {
        selected: selectedModel,
        reason: userWantsClaude ? 'explicit_request' : (forceClaude ? 'forceClaude' : 'default'),
        qualityGate: shouldCritique(category, text, useClaudeClient),
      },
      plan: null,
      toolsCalled: _lastToolsCalled,
      totalTimeMs: Date.now() - routeStart,
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

// ── GROUP MODE RESPONSE (segmentation + critique/summary execution) ─────────
// Simpler path: custom system prompt, limited tools (memory + web), no routing.
// Used for devil's advocate and summary modes.

const GROUP_MODE_TOOLS = TOOL_DEFINITIONS.filter(t =>
  ['memory_search', 'web_search', 'web_fetch'].includes(t.name)
);

/**
 * Generate a response for group analysis modes (segmentation, critique, summary).
 * Uses MiniMax for segmentation (fast), Opus for execution (accuracy matters).
 *
 * @param {string} systemPrompt - Custom system prompt for this step
 * @param {string} userMessage - The user-facing message/prompt
 * @param {boolean} useOpus - Whether to force Claude Opus (for execution step)
 * @param {string} senderJid - Sender JID for tool execution
 * @param {string} chatJid - Chat JID for tool execution
 * @returns {string|null} - Response text
 */
export async function getGroupModeResponse(systemPrompt, userMessage, useOpus = false, senderJid = null, chatJid = null) {
  const activeClient = useOpus ? claudeClient : client;
  const activeModel = useOpus ? config.claudeModel : defaultModel;
  const breaker = useOpus ? claudeBreaker : (minimaxClient ? minimaxBreaker : claudeBreaker);

  const system = [{ type: 'text', text: systemPrompt }];
  const messages = [{ role: 'user', content: userMessage }];
  const tools = useOpus ? GROUP_MODE_TOOLS : []; // only give tools on execution step

  try {
    let response = await breaker.call(
      () => activeClient.messages.create({
        model: activeModel,
        max_tokens: 4000,
        system,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }),
      null,
    );

    if (!response) return null;
    trackTokens(response);

    // Tool loop (only during execution with Opus)
    let loopCount = 0;
    while (response.stop_reason === 'tool_use' && loopCount < 5) {
      loopCount++;
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        logger.info({ tool: toolUse.name, mode: 'group_mode' }, 'group-mode tool call');
        let result = await executeTool(toolUse.name, toolUse.input, senderJid, chatJid);
        if (result.length > 1500) result = result.slice(0, 1500) + '\n[...truncated]';
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
      }
      messages.push({ role: 'user', content: toolResults });

      response = await breaker.call(
        () => activeClient.messages.create({
          model: activeModel,
          max_tokens: 4000,
          system,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        }),
        null,
      );
      if (!response) break;
      trackTokens(response);
    }

    const textBlocks = response.content.filter(b => b.type === 'text');
    return textBlocks.map(b => b.text).join('\n') || null;
  } catch (err) {
    logger.error({ err: err.message, model: activeModel }, 'group-mode API error');
    return null;
  }
}
