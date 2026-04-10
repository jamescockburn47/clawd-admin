// src/overnight/runner.ts — overnight orchestrator skeleton.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §3, §5.4, §5.5.
//
// Phase 0 ships the skeleton only. Stage bodies live in Phases 1-4 and are
// plugged in via runner.register(stage, fn). The skeleton enforces:
//   - budget tracking (via BudgetTracker)
//   - "no event = did not happen" synthetic failure events
//   - janitor sweep of stale worktrees before any stage runs
//   - unknown stage rejection
//
// This file intentionally contains no stage business logic.

import { appendEvent, queryEvents, type OvernightEvent, type OvernightStage } from './events.js';
import { BudgetTracker, type BudgetNightMode } from './budget.js';
import { janitorSweep } from './worktree.js';

export interface StageContext {
  stage: OvernightStage;
  date: string;
  overnightDir: string;
  repoRoot: string;
  budget: BudgetTracker;
  appendEvent: (event: Omit<OvernightEvent, 'id' | 'timestamp'>) => Promise<OvernightEvent>;
}

export type StageFn = (ctx: StageContext) => Promise<void>;

export interface OvernightRunnerOptions {
  mode: BudgetNightMode;
  date: string; // YYYY-MM-DD
  overnightDir: string;
  repoRoot: string;
  now?: () => Date;
  skipJanitor?: boolean;
}

export class OvernightRunner {
  private readonly opts: Required<Omit<OvernightRunnerOptions, 'now' | 'skipJanitor'>> & {
    now: () => Date;
    skipJanitor: boolean;
  };
  private readonly stages = new Map<OvernightStage, StageFn>();
  readonly budget: BudgetTracker;

  constructor(opts: OvernightRunnerOptions) {
    this.opts = {
      mode: opts.mode,
      date: opts.date,
      overnightDir: opts.overnightDir,
      repoRoot: opts.repoRoot,
      now: opts.now ?? (() => new Date()),
      skipJanitor: opts.skipJanitor ?? false,
    };
    this.budget = new BudgetTracker({ mode: opts.mode, now: this.opts.now });
  }

  register(stage: OvernightStage, fn: StageFn): void {
    this.stages.set(stage, fn);
  }

  async run(order: OvernightStage[]): Promise<void> {
    // Reject unknown stages before doing any work.
    for (const s of order) {
      if (!this.stages.has(s)) {
        throw new Error(`stage "${s}" is not registered`);
      }
    }

    if (!this.opts.skipJanitor) {
      try {
        await janitorSweep({ repoRoot: this.opts.repoRoot });
      } catch (err) {
        // intentional: janitor failure is not fatal, just record and continue
        console.error(`runner: janitorSweep failed: ${(err as Error).message}`);
      }
    }

    for (const stage of order) {
      await this.runStage(stage);
    }
  }

  private async runStage(stage: OvernightStage): Promise<void> {
    const fn = this.stages.get(stage)!; // Existence already checked in run()
    const eventsBefore = await queryEvents({
      date: this.opts.date,
      stage,
      overnightDir: this.opts.overnightDir,
    });
    const beforeCount = eventsBefore.length;

    const ctx: StageContext = {
      stage,
      date: this.opts.date,
      overnightDir: this.opts.overnightDir,
      repoRoot: this.opts.repoRoot,
      budget: this.budget,
      appendEvent: (event) => appendEvent(event, {
        date: this.opts.date,
        overnightDir: this.opts.overnightDir,
      }),
    };

    try {
      await fn(ctx);
    } catch (err) {
      await appendEvent(
        {
          stage,
          phase: 'runner',
          inputs: [],
          outputs: [],
          verdict: 'failed',
          reason: `stage threw: ${(err as Error).message}`,
          evidence_refs: [],
          rollback_ref: null,
          budget: { opus_sessions: 0, tokens: 0 },
        },
        { date: this.opts.date, overnightDir: this.opts.overnightDir },
      );
      return;
    }

    const eventsAfter = await queryEvents({
      date: this.opts.date,
      stage,
      overnightDir: this.opts.overnightDir,
    });
    if (eventsAfter.length === beforeCount) {
      await appendEvent(
        {
          stage,
          phase: 'runner',
          inputs: [],
          outputs: [],
          verdict: 'failed',
          reason: 'no event produced — treating as silent failure (spec §5.4)',
          evidence_refs: [],
          rollback_ref: null,
          budget: { opus_sessions: 0, tokens: 0 },
        },
        { date: this.opts.date, overnightDir: this.opts.overnightDir },
      );
    }
  }
}
