// src/tools/briefing.ts — Live research briefing tool
// Produces grounded, cited synthesis via Perplexity Sonar.
// Falls back to SearXNG if Sonar is unavailable.

import { sonarFast, sonarDeep, isSonarAvailable } from '../sonar-client.js';
import { searchMemory } from '../memory.js';
import { webSearch as searxngSearch } from './search.js';
import logger from '../logger.js';

interface BriefingInput {
  topic: string;
  depth?: 'quick' | 'deep';
}

/**
 * Research a topic and produce a structured briefing with citations.
 * Uses Sonar for synthesis, memory for group context, SearXNG as fallback.
 */
export async function liveBriefing({ topic, depth }: BriefingInput): Promise<string> {
  if (!topic?.trim()) return 'Topic is required for a briefing.';

  const isDeep = depth === 'deep';
  const t0 = Date.now();

  // Run research and memory context in parallel
  const [research, memories] = await Promise.all([
    fetchResearch(topic, isDeep),
    fetchMemoryContext(topic),
  ]);

  if (!research.content) {
    return `Could not find research on "${topic}". Try rephrasing the query.`;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  logger.info({ topic, depth: isDeep ? 'deep' : 'quick', elapsed, source: research.source }, 'briefing complete');

  return formatBriefing(topic, research, memories, elapsed);
}

// --- Research fetching ---

interface ResearchResult {
  content: string;
  citations: string[];
  source: 'sonar' | 'sonar-pro' | 'searxng';
}

async function fetchResearch(topic: string, deep: boolean): Promise<ResearchResult> {
  // Try Sonar first
  if (isSonarAvailable()) {
    const result = deep ? await sonarDeep(topic) : await sonarFast(topic);
    if (result?.content) {
      return {
        content: result.content,
        citations: result.citations,
        source: deep ? 'sonar-pro' : 'sonar',
      };
    }
  }

  // Fallback: SearXNG raw search
  const raw = await searxngSearch({ query: topic, count: 8 });
  if (raw && !raw.startsWith('No results') && !raw.startsWith('Web search')) {
    return { content: raw, citations: [], source: 'searxng' };
  }

  return { content: '', citations: [], source: 'searxng' };
}

// --- Memory context ---

async function fetchMemoryContext(topic: string): Promise<string> {
  try {
    const results = await searchMemory(topic, null, 3);
    if (!results?.length) return '';
    return results
      .map((r: any) => `- ${r.memory.fact} [${r.memory.sourceDate}]`)
      .join('\n');
  } catch {
    // intentional: memory context is optional — briefing works without it
    return '';
  }
}

// --- Formatting ---

function formatBriefing(
  topic: string,
  research: ResearchResult,
  memories: string,
  elapsed: string,
): string {
  const parts: string[] = [];

  parts.push(`*Research briefing: ${topic}*`);
  parts.push('');

  // Main content (Sonar returns prose, SearXNG returns structured results)
  if (research.source === 'searxng') {
    parts.push('_Via web search (Sonar unavailable):_');
    parts.push('');
  }
  parts.push(research.content);

  // Memory context (what we already know)
  if (memories) {
    parts.push('');
    parts.push('*What we already know:*');
    parts.push(memories);
  }

  // Sources
  if (research.citations.length > 0) {
    parts.push('');
    parts.push('*Sources:*');
    research.citations.slice(0, 5).forEach((url, i) => {
      parts.push(`${i + 1}. ${url}`);
    });
  }

  parts.push('');
  parts.push(`_${elapsed}s via ${research.source}_`);

  return parts.join('\n');
}
