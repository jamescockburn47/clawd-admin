// src/overnight/consolidate-maintenance.ts — memory + topic index maintenance.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §4.1.
//
// Wraps the existing triggerMaintenance() + topic-index functions behind a DI
// boundary so the consolidate stage never imports singletons directly.
// Errors in one sub-step do not stop the others.

export const TOPIC_INDEX_PRUNE_DAYS = 30;

export interface MaintenanceResult {
  expired: number;
  deduplicated: number;
  total_after: number;
}

export interface MaintenanceClient {
  triggerMaintenance(): Promise<MaintenanceResult>;
}

export interface TopicIndexClient {
  indexDayTopics(date: string): Promise<number>;
  pruneTopicIndex(days: number): Promise<number>;
}

export interface ConsolidateMaintenanceOptions {
  memoryClient: MaintenanceClient;
  topicClient: TopicIndexClient;
}

export interface ConsolidateMaintenanceResult {
  maintenance: MaintenanceResult | null;
  topicsIndexed: number | null;
  topicsPruned: number | null;
  errors: string[];
}

export class ConsolidateMaintenance {
  constructor(private readonly opts: ConsolidateMaintenanceOptions) {}

  async run(date: string): Promise<ConsolidateMaintenanceResult> {
    const result: ConsolidateMaintenanceResult = {
      maintenance: null,
      topicsIndexed: null,
      topicsPruned: null,
      errors: [],
    };

    try {
      result.maintenance = await this.opts.memoryClient.triggerMaintenance();
    } catch (err) {
      result.errors.push(`maintenance: ${(err as Error).message}`);
    }

    try {
      result.topicsIndexed = await this.opts.topicClient.indexDayTopics(date);
    } catch (err) {
      result.errors.push(`topic_index_day: ${(err as Error).message}`);
    }

    try {
      result.topicsPruned = await this.opts.topicClient.pruneTopicIndex(TOPIC_INDEX_PRUNE_DAYS);
    } catch (err) {
      result.errors.push(`topic_index_prune: ${(err as Error).message}`);
    }

    return result;
  }
}
