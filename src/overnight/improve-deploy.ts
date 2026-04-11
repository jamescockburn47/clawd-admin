// src/overnight/improve-deploy.ts — branch-first deploy for IMPROVE (spec §5.3).
//
// Takes the artefacts from runImplementStage, classifies the change using
// tiering.ts, and deploys via one of three paths:
//   - Tier A (non-source text/prompt/config): auto-merge on green CI
//   - Tier B (in-scope source): auto-merge on green CI AND green replay
//   - Tier C (anything else): open a DM proposal card, no auto-merge
//
// The module does NOT directly merge — it calls an injected DeployClient
// whose runCi/merge/openProposal methods the caller wires in. Keeps the
// module testable and keeps the real CI script separate from the logic.

import { classifyTier, type Tier, type TierClassification, type DiffSummary } from './tiering.js';
import type { FinalCandidate } from './improve-synthesis.js';
import type { ImplementArtifacts } from './improve-implement.js';
import type { RollingReplayResult } from './improve-replay.js';

/**
 * Parse a `git diff main --stat` output into a DiffSummary. Example input:
 *   " src/cortex.js    | 20 ++++++++++--------\n 2 files changed, 15 insertions(+), 5 deletions(-)\n"
 */
export function parseGitDiffStat(diffOutput: string): DiffSummary {
  const filesChanged: string[] = [];
  let linesChanged = 0;

  const lines = diffOutput.split('\n');
  for (const line of lines) {
    // Summary line: "2 files changed, 15 insertions(+), 5 deletions(-)"
    const summaryMatch = line.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
    if (summaryMatch) {
      linesChanged += parseInt(summaryMatch[1]!, 10) + parseInt(summaryMatch[2]!, 10);
      continue;
    }
    // Inline insertions/deletions-only summary
    const insertOnly = line.match(/(\d+) insertions?\(\+\)/);
    if (insertOnly && !summaryMatch) {
      linesChanged += parseInt(insertOnly[1]!, 10);
    }
    // File line: " path/to/file.js | 20 ++++++--"
    const fileMatch = line.match(/^\s*([^\s|]+)\s*\|\s*\d+/);
    if (fileMatch) {
      const path = fileMatch[1]!.trim();
      if (path && !filesChanged.includes(path)) {
        filesChanged.push(path);
      }
    }
  }

  return { filesChanged, linesChanged };
}

export type DeployVerdict =
  | 'merged'
  | 'merged_with_warning'
  | 'proposal_opened'
  | 'rejected'
  | 'ci_failed'
  | 'no_change';

export interface DeployClient {
  /**
   * Push the worktree's branch to origin/<branchName>. Returns the pushed
   * branch ref on success, throws on failure.
   */
  pushBranch(branchName: string, worktreeDir: string): Promise<string>;
  /**
   * Run the branch-first CI script (scripts/forge-ci.sh) against the pushed
   * branch. Returns { ok: boolean, output: string }.
   */
  runCi(branchRef: string): Promise<{ ok: boolean; output: string }>;
  /**
   * Merge the branch into main. Called after CI + replay checks pass.
   */
  mergeBranch(branchRef: string): Promise<void>;
  /**
   * Open a DM proposal card to James summarising the candidate, artefacts,
   * and CI output. Called for Tier C or any gate failure.
   */
  openProposal(payload: {
    candidate: FinalCandidate;
    tier: Tier;
    artifacts: ImplementArtifacts;
    replay: RollingReplayResult | null;
    ciOutput: string | null;
    reason: string;
  }): Promise<void>;
}

export interface DeployOptions {
  candidate: FinalCandidate;
  artifacts: ImplementArtifacts;
  replay: RollingReplayResult | null;
  client: DeployClient;
  /** Injectable classifier for tests. Defaults to tiering.classifyTier. */
  classifier?: (diff: DiffSummary) => TierClassification;
}

export interface DeployResult {
  verdict: DeployVerdict;
  tier: Tier;
  branchRef: string | null;
  reason: string;
  ciOutput: string | null;
}

/**
 * Run the deploy stage. Classifies, pushes, runs CI, and either merges
 * or opens a proposal card depending on tier and gate results.
 */
export async function runDeployStage(opts: DeployOptions): Promise<DeployResult> {
  const classifier = opts.classifier ?? classifyTier;
  const diff = parseGitDiffStat(opts.artifacts.gitDiff);
  const tierResult = classifier(diff);

  if (!opts.artifacts.branch) {
    return {
      verdict: 'no_change',
      tier: tierResult.tier,
      branchRef: null,
      reason: 'no branch to deploy (artifacts.branch is null)',
      ciOutput: null,
    };
  }

  // Push the worktree branch to origin
  let pushedRef: string;
  try {
    pushedRef = await opts.client.pushBranch(
      opts.artifacts.branch,
      opts.artifacts.worktreePath,
    );
  } catch (err) {
    return {
      verdict: 'rejected',
      tier: tierResult.tier,
      branchRef: null,
      reason: `push failed: ${(err as Error).message}`,
      ciOutput: null,
    };
  }

  // Run CI against the pushed branch
  const ci = await opts.client.runCi(pushedRef);
  if (!ci.ok) {
    await opts.client.openProposal({
      candidate: opts.candidate,
      tier: tierResult.tier,
      artifacts: opts.artifacts,
      replay: opts.replay,
      ciOutput: ci.output,
      reason: 'CI failed — candidate requires manual review',
    });
    return {
      verdict: 'ci_failed',
      tier: tierResult.tier,
      branchRef: pushedRef,
      reason: 'CI failed',
      ciOutput: ci.output,
    };
  }

  // Tier gate
  switch (tierResult.tier) {
    case 'A': {
      // Non-source changes (text/prompts/config) — auto-merge on green CI alone
      await opts.client.mergeBranch(pushedRef);
      return {
        verdict: 'merged',
        tier: 'A',
        branchRef: pushedRef,
        reason: 'Tier A (non-source) auto-merged on green CI',
        ciOutput: ci.output,
      };
    }
    case 'B': {
      // Source changes — require green replay too
      if (!opts.replay) {
        await opts.client.openProposal({
          candidate: opts.candidate,
          tier: 'B',
          artifacts: opts.artifacts,
          replay: null,
          ciOutput: ci.output,
          reason: 'Tier B requires replay regression check but none was run',
        });
        return {
          verdict: 'proposal_opened',
          tier: 'B',
          branchRef: pushedRef,
          reason: 'no replay run',
          ciOutput: ci.output,
        };
      }
      if (opts.replay.verdict === 'reject') {
        await opts.client.openProposal({
          candidate: opts.candidate,
          tier: 'B',
          artifacts: opts.artifacts,
          replay: opts.replay,
          ciOutput: ci.output,
          reason: `replay regression check rejected: ${opts.replay.worseCount} worse judgments`,
        });
        return {
          verdict: 'rejected',
          tier: 'B',
          branchRef: pushedRef,
          reason: 'replay regression',
          ciOutput: ci.output,
        };
      }
      if (opts.replay.verdict === 'pass_with_warning') {
        await opts.client.mergeBranch(pushedRef);
        return {
          verdict: 'merged_with_warning',
          tier: 'B',
          branchRef: pushedRef,
          reason: `merged despite warning: ${opts.replay.warning ?? 'unknown'}`,
          ciOutput: ci.output,
        };
      }
      // verdict === 'pass' or 'skipped'
      await opts.client.mergeBranch(pushedRef);
      return {
        verdict: 'merged',
        tier: 'B',
        branchRef: pushedRef,
        reason: 'Tier B auto-merged on green CI + green replay',
        ciOutput: ci.output,
      };
    }
    case 'C': {
      // Always open a proposal — never auto-merge
      await opts.client.openProposal({
        candidate: opts.candidate,
        tier: 'C',
        artifacts: opts.artifacts,
        replay: opts.replay,
        ciOutput: ci.output,
        reason: `Tier C (${tierResult.reason}) — manual review required`,
      });
      return {
        verdict: 'proposal_opened',
        tier: 'C',
        branchRef: pushedRef,
        reason: tierResult.reason,
        ciOutput: ci.output,
      };
    }
  }
}
