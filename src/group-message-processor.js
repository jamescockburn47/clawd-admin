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
              content: `You are a fact extraction engine. Read group chat messages and extract ONLY notable, durable facts worth remembering long-term. Ignore: greetings, small talk, jokes, reactions, scheduling chatter, "ok"/"thanks" messages.

Extract facts like: decisions made, opinions stated, plans confirmed, new information shared, important dates mentioned, relationships revealed, expertise demonstrated.

TEMPORAL AWARENESS — critical:
- State facts with temporal context: "Tom is reviewing the merger docs (as of ${new Date().toISOString().split('T')[0]})" not just "Tom is reviewing the merger docs"
- For ongoing states, use present tense with date: "Ray is sceptical about the AI proposal (as of DATE)"
- For completed events, use past tense: "The team agreed to postpone the filing (3 April 2026)"
- For timeless facts (relationships, expertise), no date needed: "Artur specialises in employment law"

For each fact, output one JSON object per line:
{"fact": "temporally-framed factual statement", "tags": ["relevant", "tags"], "category": "general", "confidence": 0.8, "sender": "who said it", "temporal": "current|completed|timeless"}

If NO messages contain notable facts, output exactly: NONE

Output facts only, no explanation. /no_think`
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

    for (const line of lines) {
      try {
        const fact = JSON.parse(line);
        if (!fact.fact || fact.fact.length < 10) continue;

        const tags = [
          ...(fact.tags || []),
          fact.sender || 'unknown',
          new Date().toISOString().split('T')[0],
        ];

        await storeMemory(
          fact.fact,
          fact.category || 'general',
          tags,
          fact.confidence || 0.75,
          `group_realtime_${batch[0]?.chatJid?.slice(0, 15) || 'unknown'}`
        );
        stored++;
      } catch {
        // Skip malformed lines
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
