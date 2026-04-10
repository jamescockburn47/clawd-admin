// src/group-message-processor.js — Real-time group message processing via EVO 30B
//
// Every group message gets queued for lightweight categorisation and fact extraction.
// The 30B model runs during daytime anyway — this gives it useful work.
// Notable facts/entities are stored directly into the memory service.
// Non-notable messages are silently skipped (most messages are just chat).
//
// Rate-limited: batches of 5 messages every 30 seconds to avoid overwhelming EVO.

import config from './config.js';
import logger from './logger.js';
import { isEvoOnline, storeMemory } from './memory.js';
import { evoFetch, llamaBreaker } from './evo-client.js';

const BATCH_SIZE = 5;
const BATCH_INTERVAL_MS = 30_000;
const MAX_QUEUE_SIZE = 200;

const queue = [];
let batchTimer = null;

/**
 * Queue a group message for background processing.
 * Called from message-handler.js for every group message.
 */
export function queueGroupMessage(chatJid, senderName, text) {
  if (!config.evoMemoryEnabled || !text || text.length < 10) return;

  queue.push({
    chatJid,
    sender: senderName,
    text: text.slice(0, 500), // cap length for the prompt
    timestamp: new Date().toISOString(),
  });

  // Prevent unbounded growth
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }

  // Start batch timer if not running
  if (!batchTimer) {
    batchTimer = setTimeout(processBatch, BATCH_INTERVAL_MS);
  }
}

/**
 * Process a batch of queued messages through the 30B model.
 */
async function processBatch() {
  batchTimer = null;

  if (queue.length === 0 || !isEvoOnline()) return;

  const batch = queue.splice(0, BATCH_SIZE);

  try {
    const formatted = batch.map((m, i) =>
      `[${i + 1}] ${m.timestamp.slice(11, 16)} ${m.sender}: ${m.text}`
    ).join('\n');

    const result = await llamaBreaker.call(async () => {
      const res = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: `You are a fact and decision extraction engine. Read group chat messages and extract two categories:

1. FACTS — notable, durable facts worth remembering long-term.
2. DECISIONS — explicit decisions, action items, and commitments.

Ignore: greetings, small talk, jokes, reactions, scheduling chatter, "ok"/"thanks" messages.

FACTS: opinions stated, new information shared, dates mentioned, relationships revealed, expertise demonstrated.
DECISIONS — STRICT threshold. Only extract if there is an EXPLICIT agreement, assignment, or commitment. Do NOT extract:
- Casual suggestions ("we could do X", "maybe we should")
- Hypotheticals ("if we went with X")
- Social plans unless clearly confirmed ("yeah let's grab lunch" is NOT a decision)
Only extract: explicit agreements ("we're going with X"), assigned tasks ("I'll handle Y by Friday"), confirmed commitments with specifics.

TEMPORAL AWARENESS — critical:
- State facts with temporal context: "Tom is reviewing the merger docs (as of ${new Date().toISOString().split('T')[0]})"
- For ongoing states, use present tense with date
- For completed events, use past tense with date
- For timeless facts, no date needed

For each extraction, output one JSON object per line:
{"fact": "statement", "type": "fact|decision|action_item|commitment", "tags": ["relevant", "tags"], "category": "general", "confidence": 0.8, "sender": "who said it", "temporal": "current|completed|timeless"}

Use type "decision" for group agreements, "action_item" for assigned tasks, "commitment" for personal promises.
If NO messages contain notable content, output exactly: NONE

Output JSON only, no explanation. /no_think`
            },
            { role: 'user', content: formatted },
          ],
          temperature: 0.1,
          max_tokens: 500,
          cache_prompt: true,
        }),
        timeout: 15_000,
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    }, null);

    if (!result || result === 'NONE') {
      logger.debug({ batchSize: batch.length }, 'group-processor: no notable facts in batch');
      return;
    }

    // Parse and store each fact
    const lines = result.split('\n').filter(l => l.trim().startsWith('{'));
    let stored = 0;

    const DECISION_TYPES = new Set(['decision', 'action_item', 'commitment']);

    for (const line of lines) {
      try {
        const fact = JSON.parse(line);
        if (!fact.fact || fact.fact.length < 10) continue;

        const isDecision = DECISION_TYPES.has(fact.type);
        // Decisions need higher confidence to avoid false positives from casual chat
        if (isDecision && (fact.confidence || 0) < 0.8) continue;
        const category = isDecision ? 'group_decision' : (fact.category || 'general');
        const groupTag = batch[0]?.chatJid?.slice(0, 20) || 'unknown';

        const tags = [
          ...(fact.tags || []),
          fact.sender || 'unknown',
          new Date().toISOString().split('T')[0],
          ...(isDecision ? [fact.type, groupTag] : []),
        ];

        await storeMemory(
          fact.fact,
          category,
          tags,
          fact.confidence || 0.75,
          `group_realtime_${groupTag}`
        );
        stored++;
      } catch {
        // intentional: skip malformed JSON lines from LLM output
      }
    }

    if (stored > 0) {
      logger.info({ stored, batchSize: batch.length }, 'group-processor: facts stored');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'group-processor: batch processing failed');
    // Re-queue failed batch messages (at the front)
    queue.unshift(...batch);
  }

  // If more messages queued, schedule next batch
  if (queue.length > 0 && !batchTimer) {
    batchTimer = setTimeout(processBatch, BATCH_INTERVAL_MS);
  }
}

/**
 * Get queue stats for diagnostics.
 */
export function getProcessorStats() {
  return {
    queueLength: queue.length,
    timerActive: batchTimer !== null,
  };
}
