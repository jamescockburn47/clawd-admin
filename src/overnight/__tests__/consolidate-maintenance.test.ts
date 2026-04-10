import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsolidateMaintenance,
  type MaintenanceClient,
  type TopicIndexClient,
  TOPIC_INDEX_PRUNE_DAYS,
} from '../consolidate-maintenance.js';

function makeClient(overrides: Partial<MaintenanceClient> = {}): MaintenanceClient {
  return {
    triggerMaintenance: async () => ({ expired: 3, deduplicated: 2, total_after: 42 }),
    ...overrides,
  };
}

function makeTopicClient(overrides: Partial<TopicIndexClient> = {}): TopicIndexClient {
  return {
    indexDayTopics: async () => 5,
    pruneTopicIndex: async () => 2,
    ...overrides,
  };
}

describe('overnight/consolidate-maintenance.ConsolidateMaintenance', () => {
  it('calls triggerMaintenance and returns its result', async () => {
    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient(),
      topicClient: makeTopicClient(),
    });
    const result = await maint.run('2026-04-10');
    assert.equal(result.maintenance!.expired, 3);
    assert.equal(result.maintenance!.deduplicated, 2);
    assert.equal(result.maintenance!.total_after, 42);
  });

  it('indexes topics for the given date and prunes topics older than TOPIC_INDEX_PRUNE_DAYS', async () => {
    let pruneDaysCalled: number | null = null;
    let indexDateCalled: string | null = null;

    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient(),
      topicClient: makeTopicClient({
        indexDayTopics: async (date) => {
          indexDateCalled = date;
          return 7;
        },
        pruneTopicIndex: async (days) => {
          pruneDaysCalled = days;
          return 4;
        },
      }),
    });

    const result = await maint.run('2026-04-10');
    assert.equal(indexDateCalled, '2026-04-10');
    assert.equal(pruneDaysCalled, TOPIC_INDEX_PRUNE_DAYS);
    assert.equal(result.topicsIndexed, 7);
    assert.equal(result.topicsPruned, 4);
  });

  it('continues when maintenance fails and returns the error', async () => {
    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient({
        triggerMaintenance: async () => { throw new Error('maint boom'); },
      }),
      topicClient: makeTopicClient(),
    });
    const result = await maint.run('2026-04-10');
    assert.equal(result.maintenance, null);
    assert.match(result.errors[0]!, /maint.*maint boom/i);
    // Topic indexing still ran.
    assert.equal(result.topicsIndexed, 5);
  });

  it('continues when topic indexing fails and still runs pruning attempt', async () => {
    const maint = new ConsolidateMaintenance({
      memoryClient: makeClient(),
      topicClient: makeTopicClient({
        indexDayTopics: async () => { throw new Error('index boom'); },
      }),
    });
    const result = await maint.run('2026-04-10');
    assert.equal(result.topicsIndexed, null);
    assert.match(result.errors[0]!, /topic_index.*index boom/i);
  });
});
