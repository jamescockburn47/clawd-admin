// src/project-thinker.js — Overnight deep thinking on projects
// Runs separately from the diary. Uses premium models (Opus, GPT, thinking models)
// for strategic reflection on active projects.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { storeMemory, searchMemory, isEvoOnline } from './memory.js';
import { webSearch, webFetch } from './tools/search.js';
import config from './config.js';
import logger from './logger.js';

const PROJECTS_FILE = join('data', 'projects.json');

// Model configuration — override via env vars
const THINKER_MODELS = {
  primary: {
    provider: 'anthropic',
    model: process.env.THINKER_MODEL || 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    maxTokens: 4000,
  },
  secondary: {
    provider: process.env.THINKER_SECONDARY_PROVIDER || 'openai',
    model: process.env.THINKER_SECONDARY_MODEL || 'gpt-5.4',
    baseUrl: process.env.THINKER_SECONDARY_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    label: process.env.THINKER_SECONDARY_LABEL || 'GPT 5.4',
    maxTokens: 4000,
  },
  thinking: {
    provider: process.env.THINKER_THINKING_PROVIDER || 'anthropic',
    model: process.env.THINKER_THINKING_MODEL || 'claude-opus-4-6',
    label: process.env.THINKER_THINKING_LABEL || 'Claude Opus 4.6 (extended thinking)',
    maxTokens: 16000,
    extendedThinking: true,
    thinkingBudget: parseInt(process.env.THINKER_THINKING_BUDGET) || 10000,
  },
};

// Anthropic client (reusing the shared API key)
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Call Anthropic model (Sonnet, Opus, etc.)
async function callAnthropic(model, systemPrompt, userMessage, opts = {}) {
  const params = {
    model,
    max_tokens: opts.maxTokens || 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  // Extended thinking support
  if (opts.extendedThinking) {
    params.thinking = {
      type: 'enabled',
      budget_tokens: opts.thinkingBudget || 10000,
    };
  }

  const response = await anthropic.messages.create(params);

  // Extract text from content blocks
  const textBlocks = response.content.filter(b => b.type === 'text');
  const thinkingBlocks = response.content.filter(b => b.type === 'thinking');

  return {
    text: textBlocks.map(b => b.text).join('\n'),
    thinking: thinkingBlocks.map(b => b.thinking).join('\n'),
    usage: response.usage,
    model: response.model,
  };
}

// Call OpenAI-compatible API (GPT, Mistral, DeepSeek, etc.)
async function callOpenAICompat(baseUrl, apiKey, model, systemPrompt, userMessage, opts = {}) {
  if (!apiKey) {
    return { text: `[SKIPPED — no API key for ${model}]`, usage: null, model };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 4000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${model} API error: ${response.status} ${err.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: data.usage,
    model: data.model || model,
  };
}

// Unified model call dispatcher
async function callModel(modelConfig, systemPrompt, userMessage) {
  if (modelConfig.provider === 'anthropic') {
    return callAnthropic(modelConfig.model, systemPrompt, userMessage, {
      maxTokens: modelConfig.maxTokens,
      extendedThinking: modelConfig.extendedThinking,
      thinkingBudget: modelConfig.thinkingBudget,
    });
  }
  // OpenAI-compatible (GPT, Mistral, DeepSeek, Groq, etc.)
  return callOpenAICompat(
    modelConfig.baseUrl, modelConfig.apiKey, modelConfig.model,
    systemPrompt, userMessage, { maxTokens: modelConfig.maxTokens }
  );
}

function loadProjects() {
  try {
    if (!existsSync(PROJECTS_FILE)) return [];
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8')).projects || [];
  } catch { return []; }
}

function saveProjects(projects) {
  writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2));
}

// Gather today's conversation context relevant to a project
function gatherProjectContext(project) {
  const context = [];

  // 1. Today's conversation logs — scan for project-relevant keywords
  const logDir = join('data', 'conversation-logs');
  const today = new Date().toISOString().split('T')[0];

  if (existsSync(logDir)) {
    const files = readdirSync(logDir).filter(f => f.startsWith(today) && f.endsWith('.jsonl'));
    for (const file of files) {
      try {
        const lines = readFileSync(join(logDir, file), 'utf-8').trim().split('\n');
        const projectKeywords = [
          project.id,
          project.name.toLowerCase(),
          ...(project.tags || []),
        ];

        const relevantMessages = [];
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            const text = (msg.text || '').toLowerCase();
            if (projectKeywords.some(kw => text.includes(kw.toLowerCase()))) {
              relevantMessages.push(`${msg.sender || 'User'}: ${msg.text}`);
            }
          } catch {}
        }
        if (relevantMessages.length > 0) {
          context.push(`Today's relevant conversations:\n${relevantMessages.join('\n')}`);
        }
      } catch {}
    }
  }

  return context.join('\n\n---\n\n');
}

// Generate web research queries for a project — focus on CONCEPTS, not project names
// Project names like "ATLAS" are arbitrary — search for the underlying domain innovations
function generateSearchQueries(project) {
  const queries = [];

  // Tag-based concept searches — these target the actual domain
  const tagQueries = {
    'legaltech': ['AI litigation platform state of the art 2026', 'AI case management continuous reasoning'],
    'adversarial': ['multi-agent adversarial debate AI systems 2026', 'AI red team blue team automated reasoning'],
    'agi': ['artificial general intelligence breakthroughs 2026', 'recursive self-improving AI systems latest'],
    'self-improvement': ['autonomous AI self-modification systems 2026', 'AI agents that evolve own code'],
    'cognitive-architecture': ['cognitive architecture persistent memory AI 2026', 'AI agent memory systems state of art'],
    'litigation': ['AI automated legal analysis overnight processing', 'AI document contradiction detection litigation'],
    'dream-mode': ['AI overnight reflection synthesis systems', 'AI sleep cycle processing autonomous learning'],
    'ai': ['frontier AI capabilities 2026', 'AI agent orchestration multi-model'],
    'clawd-architecture': ['distributed AI assistant architecture edge computing', 'local AI models vs cloud hybrid systems'],
    'recursive': ['recursive self-improvement AI safety 2026', 'AI systems that modify own behaviour autonomously'],
    'erotetic': ['erotetic theory of reason AI reasoning', 'question-driven reasoning AI systems stopping criterion'],
  };

  for (const tag of (project.tags || [])) {
    if (tagQueries[tag]) {
      queries.push(...tagQueries[tag]);
    }
  }

  // Pull concept searches from key differentiators (these describe the actual innovation)
  if (project.keyDifferentiators) {
    // Take the first 2 differentiators and turn them into search queries
    for (const diff of project.keyDifferentiators.slice(0, 2)) {
      // Extract the concept before the dash (e.g., "Continuous reasoning" from "Continuous reasoning — the case is a living problem")
      const concept = diff.split('—')[0].trim();
      if (concept.length > 5 && concept.length < 60) {
        queries.push(`${concept} AI systems 2026`);
      }
    }
  }

  // Deduplicate and limit to 6 queries
  return [...new Set(queries)].slice(0, 6);
}

// Run web research for a project — returns formatted research text
async function runWebResearch(project) {
  const queries = generateSearchQueries(project);
  const research = [];

  for (const query of queries) {
    try {
      const searchResults = await webSearch({ query, count: 3 });
      if (searchResults.startsWith('No results') || searchResults.startsWith('Web search')) {
        continue;
      }
      research.push(`**Search: "${query}"**\n${searchResults}`);

      // Fetch the top result's URL for deeper content
      const urlMatch = searchResults.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        try {
          const content = await webFetch({ url: urlMatch[0] });
          if (content && !content.startsWith('Failed') && !content.startsWith('URL fetch') && content.length > 100) {
            research.push(`**Content from ${urlMatch[0]}:**\n${content.slice(0, 3000)}`);
          }
        } catch {}
      }
    } catch (err) {
      logger.warn({ query, err: err.message }, 'project-thinker: web search failed');
    }
  }

  if (research.length === 0) return '';
  return `\n\n## OVERNIGHT WEB RESEARCH (auto-gathered)\n${research.join('\n\n---\n\n')}`;
}

// Build the deep think prompt for a project
function buildProjectPrompt(project, todayContext, existingMemories, webResearch) {
  return `You are a strategic AI advisor performing deep overnight analysis on a project.

PROJECT: ${project.name}
STATUS: ${project.status}
ONE-LINER: ${project.oneLiner}

FULL PROJECT DATA:
${JSON.stringify(project, null, 2)}

${todayContext ? `TODAY'S RELATED CONVERSATIONS:\n${todayContext}` : 'No new conversations about this project today.'}

${existingMemories ? `EXISTING MEMORY CONTEXT:\n${existingMemories}` : ''}

${webResearch ? `RECENT WEB RESEARCH (state of the art, competitor moves, new developments):\n${webResearch}` : 'No web research available.'}

THINK DEEPLY about this project. You have unlimited time. Consider:

1. **Strategic Position**: Where does this stand? What's the one thing that most needs addressing?
2. **Technical Feasibility**: Which parts are buildable RIGHT NOW with existing infrastructure?
3. **Competitive Landscape**: What exists? What's the actual differentiation? Be honest.
4. **SOTA Developments**: Based on the web research, what are competitors doing? What can be learned?

OUTPUT FORMAT — ACTIONABLE, NOT STRATEGIC COMMENTARY:

## Situation (max 2 paragraphs)
[What's happened since last analysis. What's changed. What's the single most important thing to know. TWO PARAGRAPHS MAX — this is context, not the deliverable.]

## This Week's Actions (3 items max)
[THE MOST IMPORTANT SECTION. Each action must be:
- Specific enough that James can start immediately without further planning
- Include a time estimate (e.g. "~2 hours", "~30 min")  
- Include what the concrete output/deliverable is (e.g. "produces: a .md file with...", "produces: a working Python script that...")
- NOT strategic advice. NOT "think about X". Actual tasks with verifiable completion.

Example of GOOD: "Build erotetic case analyser prototype (~3 hours). Take one real case. Write a Python script that: ingests case docs → generates the 5 most dangerous unanswered questions → for each question, searches for evidence that answers it → outputs a structured report. Produces: working script + one sample output to send to Shlomo."

Example of BAD: "Consider implementing the erotetic framework across the agent pipeline to improve output quality."]

## If You Have 4 Hours Right Now
[Name exactly ONE thing. What to build, what file to create, what the output looks like when done. No decisions required — just execution instructions.]

## Non-Obvious Insight
[ONE thing the overnight analysis surfaced that isn't visible from a surface reading. Not a recommendation — an observation that changes how you think about the project.]

[STRUCTURED_INSIGHTS]
One JSON object per line — insights to store in memory for future reference:
{"insight": "...", "topics": ["..."], "project": "${project.id}", "confidence": 0.8}`;
}

// Parse structured insights from model output
function parseInsights(text, projectId) {
  const insights = [];
  const insightsMatch = text.match(/\[STRUCTURED_INSIGHTS\]([\s\S]*?)$/);
  if (!insightsMatch) return insights;

  const lines = insightsMatch[1].trim().split('\n');
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.insight) {
        insights.push({
          insight: obj.insight,
          topics: obj.topics || [],
          project: projectId,
          confidence: obj.confidence || 0.7,
        });
      }
    } catch {}
  }
  return insights;
}

// Main deep think cycle for all active projects
export async function runProjectDeepThink(sendFn) {
  const projects = loadProjects();
  if (projects.length === 0) {
    logger.info('project-thinker: no projects defined, skipping');
    return { skipped: true };
  }

  const results = [];
  const startTime = Date.now();

  for (const project of projects) {
    // Skip archived projects
    if (project.status === 'archived') continue;

    logger.info({ project: project.id }, 'project-thinker: starting deep think');

    try {
      // Gather context
      const todayContext = gatherProjectContext(project);

      // Search existing memories about this project
      let existingMemories = '';
      if (isEvoOnline()) {
        try {
          const memories = await searchMemory(project.name, null, 5);
          if (memories.length > 0) {
            existingMemories = memories.map(r => r.memory.fact).join('\n');
          }
        } catch {}
      }

      // Run web research — surface SOTA innovations from competitors and adjacent fields
      let webResearch = '';
      try {
        logger.info({ project: project.id }, 'project-thinker: running SOTA web research');
        webResearch = await runWebResearch(project);
        const researchCount = (webResearch.match(/\*\*Search:/g) || []).length;
        logger.info({ project: project.id, searches: researchCount }, 'project-thinker: web research complete');
      } catch (err) {
        logger.warn({ err: err.message }, 'project-thinker: web research failed (continuing without)');
      }

      const systemPrompt = buildProjectPrompt(project, todayContext, existingMemories, webResearch);

      // --- PRIMARY: Claude Opus (deep strategic reasoning) ---
      let primaryResult = null;
      try {
        logger.info({ model: THINKER_MODELS.primary.label, project: project.id }, 'project-thinker: calling primary model');
        primaryResult = await callModel(THINKER_MODELS.primary, 
          'You are a world-class strategic advisor with deep expertise in technology, law, AI architecture, and startup strategy. Think carefully and deeply.',
          systemPrompt
        );
        logger.info({ model: primaryResult.model, tokens: primaryResult.usage }, 'project-thinker: primary model complete');
      } catch (err) {
        logger.error({ err: err.message, model: THINKER_MODELS.primary.label }, 'project-thinker: primary model failed');
      }

      // --- SECONDARY: GPT 5.4 / alternative (different perspective) ---
      let secondaryResult = null;
      if (THINKER_MODELS.secondary.apiKey) {
        try {
          logger.info({ model: THINKER_MODELS.secondary.label, project: project.id }, 'project-thinker: calling secondary model');
          secondaryResult = await callModel(THINKER_MODELS.secondary,
            'You are a world-class strategic advisor. Provide a DIFFERENT perspective from what a typical AI might give. Challenge assumptions. Find blind spots.',
            systemPrompt
          );
          logger.info({ model: secondaryResult.model }, 'project-thinker: secondary model complete');
        } catch (err) {
          logger.warn({ err: err.message, model: THINKER_MODELS.secondary.label }, 'project-thinker: secondary model failed (continuing)');
        }
      }

      // --- THINKING: Extended thinking mode (deep reasoning chain) ---
      let thinkingResult = null;
      if (THINKER_MODELS.thinking.extendedThinking) {
        try {
          logger.info({ model: THINKER_MODELS.thinking.label, project: project.id }, 'project-thinker: calling thinking model');
          thinkingResult = await callModel(THINKER_MODELS.thinking,
            'Think very carefully and deeply about this project. Use your full reasoning capacity. Find non-obvious connections and risks.',
            systemPrompt
          );
          logger.info({ model: thinkingResult.model }, 'project-thinker: thinking model complete');
        } catch (err) {
          logger.warn({ err: err.message, model: THINKER_MODELS.thinking.label }, 'project-thinker: thinking model failed (continuing)');
        }
      }

      // --- SYNTHESIS: Combine insights from all models ---
      const allOutputs = [];
      if (primaryResult?.text) allOutputs.push({ source: THINKER_MODELS.primary.label, text: primaryResult.text });
      if (secondaryResult?.text) allOutputs.push({ source: THINKER_MODELS.secondary.label, text: secondaryResult.text });
      if (thinkingResult?.text) allOutputs.push({ source: THINKER_MODELS.thinking.label, text: thinkingResult.text });

      if (allOutputs.length === 0) {
        logger.warn({ project: project.id }, 'project-thinker: all models failed, skipping');
        continue;
      }

      // Store combined analysis in memory
      const combinedAnalysis = allOutputs.map(o => 
        `=== ${o.source} ===\n${o.text}`
      ).join('\n\n---\n\n');

      // Extract and store structured insights
      let totalInsights = 0;
      for (const output of allOutputs) {
        const insights = parseInsights(output.text, project.id);
        for (const insight of insights) {
          if (isEvoOnline()) {
            try {
              await storeMemory(
                `[Project: ${project.id}] ${insight.insight}`,
                'insight',
                [...insight.topics, 'project_deep_think', project.id],
                insight.confidence,
                'project_thinker'
              );
              totalInsights++;
            } catch {}
          }
        }
      }

      // Store the full analysis as a project memory
      if (isEvoOnline()) {
        try {
          const summaryText = primaryResult?.text?.slice(0, 2000) || allOutputs[0].text.slice(0, 2000);
          await storeMemory(
            `[Deep Think ${new Date().toISOString().split('T')[0]}] ${project.name}: ${summaryText}`,
            'system',
            ['project_deep_think', project.id, 'overnight'],
            0.9,
            'project_thinker'
          );
        } catch {}
      }

      // Save analysis to project file for quick access
      const projectIdx = projects.findIndex(p => p.id === project.id);
      if (projectIdx !== -1) {
        projects[projectIdx].lastDeepThink = {
          date: new Date().toISOString(),
          models: allOutputs.map(o => o.source),
          insightsExtracted: totalInsights,
          // Store a summary, not the full output (keep the JSON manageable)
          summary: (primaryResult?.text || allOutputs[0].text)
            .replace(/\[STRUCTURED_INSIGHTS\][\s\S]*$/, '')
            .trim()
            .slice(0, 3000),
        };
        projects[projectIdx].updated = new Date().toISOString();
      }

      results.push({
        project: project.id,
        models: allOutputs.map(o => o.source),
        insights: totalInsights,
        success: true,
      });

      // Send summary to James
      if (sendFn) {
        const researchCount = (webResearch.match(/\*\*Search:/g) || []).length;
        let msg = `*🧠 Deep Think: ${project.name}*\n\n`;
        msg += `Models: ${allOutputs.map(o => o.source).join(', ')}\n`;
        msg += `Web searches: ${researchCount}\n`;
        msg += `Insights stored: ${totalInsights}\n\n`;

        // Extract actionable sections from primary output
        const primaryText = primaryResult?.text || '';
        
        const actionsMatch = primaryText.match(/## This Week's Actions[\s\S]*?(?=##|\[STRUCTURED|$)/);
        if (actionsMatch) {
          msg += `${actionsMatch[0].trim().slice(0, 800)}\n\n`;
        }

        const fourHoursMatch = primaryText.match(/## If You Have 4 Hours Right Now([\s\S]*?)(?=##|\[STRUCTURED|$)/);
        if (fourHoursMatch) {
          msg += `*If you have 4 hours right now:*\n${fourHoursMatch[1].trim().slice(0, 400)}`;
        } else {
          // Fallback to old format
          const stepsMatch = primaryText.match(/## Recommended Next Steps([\s\S]*?)(?=##|\[STRUCTURED|$)/);
          if (stepsMatch) {
            msg += `*Next steps:*\n${stepsMatch[1].trim().slice(0, 500)}`;
          }
        }

        await sendFn(msg);
      }

    } catch (err) {
      logger.error({ project: project.id, err: err.message }, 'project-thinker: project analysis failed');
      results.push({ project: project.id, success: false, error: err.message });
    }
  }

  // Save updated projects
  saveProjects(projects);

  const elapsed = Date.now() - startTime;
  logger.info({ projects: results.length, elapsed, results }, 'project-thinker: cycle complete');

  return { results, elapsed };
}
