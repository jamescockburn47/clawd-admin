// src/tools/group-decisions.ts — Query group decisions, action items, and commitments
// Searches memories stored with category 'group_decision' by the group message processor.

import { searchMemory } from '../memory.js';
import logger from '../logger.js';

interface DecisionQueryInput {
  query?: string;
  days_back?: number;
  type?: 'decision' | 'action_item' | 'commitment' | 'all';
}

/**
 * Search group decisions, action items, and commitments from conversation history.
 * Memories are extracted in real-time by group-message-processor and stored
 * with category 'group_decision' and type tags.
 */
export async function groupDecisions({ query, days_back, type }: DecisionQueryInput): Promise<string> {
  const daysBack = Math.min(90, Math.max(1, days_back ?? 7));
  const filterType = type ?? 'all';

  try {
    // Build search query — if user provided one, use it; otherwise search broadly
    const searchQuery = query?.trim() || 'decision agreed committed action item plan';
    const results = await searchMemory(searchQuery, 'group_decision', 20);

    if (!results?.length) {
      return query
        ? `No group decisions found matching "${query}" in the last ${daysBack} days.`
        : `No group decisions recorded in the last ${daysBack} days.`;
    }

    // Filter by date range
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let filtered = results.filter((r: any) => {
      const date = r.memory.sourceDate;
      return date >= cutoffStr;
    });

    // Filter by type if specified
    if (filterType !== 'all') {
      filtered = filtered.filter((r: any) => {
        const tags = r.memory.tags || [];
        return tags.includes(filterType);
      });
    }

    if (filtered.length === 0) {
      return `No ${filterType === 'all' ? '' : filterType + ' '}decisions found${query ? ` matching "${query}"` : ''} in the last ${daysBack} days.`;
    }

    // Format output grouped by date
    const byDate = new Map<string, any[]>();
    for (const r of filtered) {
      const date = r.memory.sourceDate;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(r.memory);
    }

    const parts: string[] = [];
    parts.push(`*Group decisions${query ? ` matching "${query}"` : ''} (last ${daysBack} days):*`);
    parts.push('');

    for (const [date, memories] of [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      parts.push(`*${date}:*`);
      for (const m of memories) {
        const typeTag = (m.tags || []).find((t: string) =>
          ['decision', 'action_item', 'commitment'].includes(t));
        const prefix = typeTag === 'action_item' ? 'ACTION'
          : typeTag === 'commitment' ? 'COMMITMENT'
          : 'DECISION';
        const conf = m.confidence >= 0.8 ? '' : ' (uncertain)';
        parts.push(`  [${prefix}] ${m.fact}${conf}`);
      }
      parts.push('');
    }

    logger.info({ query, daysBack, filterType, count: filtered.length }, 'group decisions query');
    return parts.join('\n').trim();
  } catch (err: any) {
    logger.error({ err: err.message, query }, 'group decisions query failed');
    return `Error searching group decisions: ${err.message}`;
  }
}
