// LQuorum Conversational Working Memory
// Passively tracks group discussion topics and pre-stages knowledge for instant retrieval
import { readFileSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

// ── Knowledge store (loaded once at startup) ────────────────────────────────

let resources = null;

try {
  const path = join(process.cwd(), 'data', 'lquorum-knowledge.json');
  const repo = JSON.parse(readFileSync(path, 'utf-8'));
  resources = repo.resources || {};
  logger.info({ topics: Object.keys(resources).length }, 'lquorum knowledge loaded');
} catch (err) {
  logger.warn({ err: err.message }, 'failed to load lquorum knowledge — working memory disabled');
  resources = {};
}

// ── Keyword → topic map ─────────────────────────────────────────────────────

const TOPIC_KEYWORDS = {
  'rag-hallucinations': ['rag', 'hallucination', 'hallucinate', 'provenance', 'citation check',
    'invented case', 'fabricated', 'retrieval augmented', 'vector search', 'embedding model'],
  'doc-processing': ['document processing', 'ocr', 'pdf extraction', 'document parsing',
    'marker', 'docling', 'unstructured'],
  'docx-problem': ['docx', 'word document', 'word format', 'track changes', '.docx',
    'word processing', 'office format'],
  'data-security': ['privilege', 'data security', 'confidential', 'gdpr', 'data protection',
    'air gap', 'legal privilege', 'waiver'],
  'platform-reviews': ['harvey', 'legora', 'cocounsel', 'luminance', 'legal ai platform',
    'which platform', 'clio', 'kira'],
  'copilot-legal': ['copilot', 'microsoft copilot', 'copilot for law', 'm365 copilot'],
  'claude-code': ['claude code', 'cursor', 'coding assistant', 'mcp server',
    'agentic coding', 'windsurf'],
  'local-models': ['local model', 'on-premise', 'self-hosted', 'llama', 'run locally',
    'gpu', 'hardware for ai', 'local llm', 'ollama'],
  'vibe-coding': ['vibe coding', 'vibe code', 'no-code', 'low-code', 'lawyer coding',
    'cursor for lawyers', 'build my own'],
  'tool-showcase': ['tool showcase', 'show and tell', 'demo day', 'what i built',
    'side project'],
  'tool-reviews': ['tool review', 'which tool', 'tool comparison', 'best ai tool',
    'recommend a tool'],
  'ai-native-firms': ['ai native', 'ai-first firm', 'new law firm', 'ai law firm',
    'starting a firm'],
  'contract-review-ai': ['contract review', 'contract analysis', 'clause extraction',
    'due diligence ai', 'contract ai'],
  'it-gatekeepers': ['it department', 'it gatekeeper', 'shadow it', 'it approval',
    'enterprise ai', 'it blocking'],
  'ai-disruption': ['disruption', 'future of law', 'ai replacing', 'lawyer jobs',
    'billable hours', 'ai impact'],
  'agent-security': ['agent security', 'ai agent risk', 'autonomous agent', 'guardrails',
    'agent safety', 'tool use security'],
  'model-comparison': ['which model', 'model comparison', 'gpt vs claude', 'best model',
    'model selection', 'reasoning model', 'o1 vs', 'o3 vs'],
  'about-legal-quants': ['legal quant', 'lquorum', 'legal quants', 'community',
    'the group', 'this group'],
};

// ── Working memory ───────────────────────────────────────────────────────────

const workingMemory = new Map();

const BASE_DECAY_MS = 15 * 60 * 1000;
const EXTENDED_DECAY_MS = 30 * 60 * 1000;
const EXTENDED_THRESHOLD = 3;
const MAX_WARM_TOPICS = 2;
const MIN_MESSAGE_LENGTH = 50;

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

function stripEmoji(str) {
  return str.replace(EMOJI_RE, '').trim();
}

function isPunctHeavy(text) {
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length < text.length * 0.2;
}

function isDirectReply(text) {
  return /^@\w+\s*$/i.test(text.trim());
}

function pruneDecayed() {
  const now = Date.now();
  for (const [topicId, entry] of workingMemory) {
    const decay = entry.hitCount >= EXTENDED_THRESHOLD ? EXTENDED_DECAY_MS : BASE_DECAY_MS;
    if (now - entry.lastMentioned > decay) {
      workingMemory.delete(topicId);
      logger.debug({ topicId, hitCount: entry.hitCount }, 'lquorum topic decayed from working memory');
    }
  }
}

function matchTopics(text) {
  const lower = text.toLowerCase();
  const matched = [];
  for (const [topicId, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(topicId);
        break;
      }
    }
  }
  return matched;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function scanMessage(text) {
  if (!text || !resources) return;
  if (text.length < MIN_MESSAGE_LENGTH) return;
  if (isPunctHeavy(text)) return;
  if (isDirectReply(text)) return;

  pruneDecayed();

  const matched = matchTopics(text);
  const now = Date.now();

  for (const topicId of matched) {
    const existing = workingMemory.get(topicId);
    if (existing) {
      existing.lastMentioned = now;
      existing.hitCount++;
    } else if (resources[topicId]) {
      workingMemory.set(topicId, {
        resource: resources[topicId],
        lastMentioned: now,
        hitCount: 1,
        warmSince: now,
      });
      logger.info({ topicId, title: resources[topicId].title }, 'lquorum topic warmed');
    }
  }
}

/**
 * Warm topics from a direct query — no length filter, no punct filter.
 * Called at response time for the message Clawd is actually replying to.
 * Passive scan filters are too aggressive for short direct questions like "what about harvey?"
 */
export function warmFromQuery(text) {
  if (!text || !resources) return;
  const matched = matchTopics(text);
  const now = Date.now();
  for (const topicId of matched) {
    const existing = workingMemory.get(topicId);
    if (existing) {
      existing.lastMentioned = now;
      existing.hitCount++;
    } else if (resources[topicId]) {
      workingMemory.set(topicId, {
        resource: resources[topicId],
        lastMentioned: now,
        hitCount: 1,
        warmSince: now,
      });
      logger.info({ topicId, title: resources[topicId].title }, 'lquorum topic warmed (direct query)');
    }
  }
}

export function getWarmTopicTitles() {
  pruneDecayed();
  return [...workingMemory.values()].map(e => e.resource.title);
}

export function getWorkingKnowledge() {
  pruneDecayed();
  if (workingMemory.size === 0) return null;

  const entries = [...workingMemory.entries()]
    .sort((a, b) => b[1].hitCount - a[1].hitCount)
    .slice(0, MAX_WARM_TOPICS);

  const sections = [];

  for (const [, { resource }] of entries) {
    const lines = [];
    lines.push(`### ${stripEmoji(resource.title)}`);
    lines.push(`*You remember this being discussed by ${resource.contributorCount} people across ${resource.jurisdictionCount} jurisdictions*`);

    if (resource.keyFindings?.length > 0) {
      lines.push('');
      lines.push('**What the group concluded:**');
      for (const f of resource.keyFindings) {
        const tag = f.confidence === 'consensus' ? 'general agreement' : 'some people thought';
        lines.push(`- [${tag}] ${stripEmoji(f.insight)}`);
      }
    }

    if (resource.practicalConsensus?.length > 0) {
      lines.push('');
      lines.push('**What people agreed works in practice:**');
      for (const pc of resource.practicalConsensus) {
        lines.push(`- ${stripEmoji(pc)}`);
      }
    }

    if (resource.activeDebates?.length > 0) {
      lines.push('');
      lines.push('**Where people disagreed:**');
      for (const d of resource.activeDebates) {
        const positions = d.positions
          .map(p => `${p.by}: ${stripEmoji(p.position).slice(0, 120)}`)
          .join(' vs. ');
        lines.push(`- ${stripEmoji(d.question)} (${positions})`);
      }
    }

    sections.push(lines.join('\n'));
  }

  return `## Memories from previous group discussions
These are things you remember from earlier conversations in this community. They are memories, not facts — the group may have been wrong, things may have changed, and you can disagree. Use them as context: reference them naturally ("we talked about this before"), add your own perspective, challenge outdated points, or use web_search to check if something has moved on. Do not just recite these — think about them like a person who remembers a conversation and has their own views.

${sections.join('\n\n')}`;
}

export function getWorkingMemoryState() {
  pruneDecayed();
  const state = {};
  for (const [topicId, entry] of workingMemory) {
    state[topicId] = {
      title: entry.resource.title,
      hitCount: entry.hitCount,
      warmSince: entry.warmSince,
      lastMentioned: entry.lastMentioned,
      ageSeconds: Math.round((Date.now() - entry.warmSince) / 1000),
      decayType: entry.hitCount >= EXTENDED_THRESHOLD ? 'extended' : 'base',
    };
  }
  return state;
}
