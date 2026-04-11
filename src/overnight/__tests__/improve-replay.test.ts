import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stratifiedSample,
  runRollingReplay,
  type ReplayPairClient,
  type StratifiedGrader,
  type StratifiedSample,
  STRATA,
  SENSITIVE_TERMS,
} from '../improve-replay.js';
import type { HistoricalExchange } from '../probe-drift.js';

function makeExchange(text: string, category: string = 'conversational'): HistoricalExchange {
  return {
    userInput: text,
    botResponse: `response to ${text}`,
    original_timestamp: '2026-04-10T10:00:00Z',
    inputHash: `sha256:${text.slice(0, 6)}`,
    // @ts-expect-error test-only: add category metadata used by stratifier
    category,
  };
}

describe('overnight/improve-replay.stratifiedSample', () => {
  it('returns empty array when no exchanges provided', () => {
    const result = stratifiedSample([], { targetSize: 20 });
    assert.deepEqual(result, []);
  });

  it('picks at least one exchange per non-empty stratum when possible', () => {
    const exchanges = [
      makeExchange('hi', 'conversational'),
      makeExchange('plan my week', 'planning'),
      makeExchange('what did I say', 'recall'),
      makeExchange('capital of France', 'general_knowledge'),
      makeExchange('what is a tool', 'system'),
    ];
    const result = stratifiedSample(exchanges, { targetSize: 20 });
    const cats = new Set(result.map((r) => r.category));
    // All five strata should be represented
    assert.equal(cats.size, 5);
  });

  it('caps the total sample size at the target', () => {
    const exchanges: HistoricalExchange[] = [];
    for (let i = 0; i < 100; i++) {
      exchanges.push(makeExchange(`q${i}`, STRATA[i % STRATA.length]!));
    }
    const result = stratifiedSample(exchanges, { targetSize: 20 });
    assert.equal(result.length, 20);
  });

  it('skips exchanges whose input contains a sensitive term', () => {
    // Pass an injected sensitive-term list; the module-level constant is
    // intentionally empty until populated for production. _ marker for unused
    // SENSITIVE_TERMS import kept for type stability in other tests.
    void SENSITIVE_TERMS;
    const exchanges = [
      makeExchange('tell me about CLIENT_ACME'),
      makeExchange('normal query'),
    ];
    const result = stratifiedSample(exchanges, {
      targetSize: 20,
      sensitiveTerms: ['CLIENT_ACME'],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.userInput, 'normal query');
  });
});

describe('overnight/improve-replay.runRollingReplay', () => {
  function makeReplayPair(
    mainResponse: string | null,
    worktreeResponse: string | null,
  ): ReplayPairClient {
    return {
      replayAgainstMain: async () => mainResponse,
      replayAgainstWorktree: async () => worktreeResponse,
    };
  }

  function makeGrader(
    judgements: Array<'better' | 'worse' | 'neutral'>,
  ): StratifiedGrader {
    let i = 0;
    return {
      grade: async () => {
        const j = judgements[i % judgements.length]!;
        i++;
        return { judged: j, reason: `grader test verdict ${j}` };
      },
    };
  }

  function makeSamples(n: number): StratifiedSample[] {
    const samples: StratifiedSample[] = [];
    for (let i = 0; i < n; i++) {
      samples.push({
        userInput: `query ${i}`,
        botResponse: `original response ${i}`,
        original_timestamp: '2026-04-10T10:00:00Z',
        inputHash: `sha256:h${i}`,
        category: STRATA[i % STRATA.length]!,
      });
    }
    return samples;
  }

  it('rejects with any "worse" judgment (hard-reject rule)', async () => {
    const samples = makeSamples(3);
    const result = await runRollingReplay({
      samples,
      replayPair: makeReplayPair('main response', 'worktree response'),
      grader: makeGrader(['better', 'worse', 'neutral']),
    });
    assert.equal(result.verdict, 'reject');
    assert.equal(result.worseCount, 1);
  });

  it('passes when ≥2 "better" and zero "worse"', async () => {
    const samples = makeSamples(3);
    const result = await runRollingReplay({
      samples,
      replayPair: makeReplayPair('main', 'worktree'),
      grader: makeGrader(['better', 'better', 'neutral']),
    });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.betterCount, 2);
    assert.equal(result.worseCount, 0);
  });

  it('passes-with-warning when all results are neutral', async () => {
    const samples = makeSamples(3);
    const result = await runRollingReplay({
      samples,
      replayPair: makeReplayPair('main', 'worktree'),
      grader: makeGrader(['neutral', 'neutral', 'neutral']),
    });
    assert.equal(result.verdict, 'pass_with_warning');
    assert.match(result.warning ?? '', /no material effect/i);
  });

  it('records which exchange triggered a reject', async () => {
    const samples = makeSamples(3);
    const result = await runRollingReplay({
      samples,
      replayPair: makeReplayPair('main', 'worktree'),
      grader: makeGrader(['neutral', 'worse', 'better']),
    });
    assert.equal(result.verdict, 'reject');
    assert.ok(result.worseExchanges.length >= 1);
    assert.equal(result.worseExchanges[0]!.inputHash, 'sha256:h1');
  });

  it('treats Levenshtein-near-identical responses as neutral without grading', async () => {
    const samples = makeSamples(2);
    // Identical responses should skip the grader call entirely
    let graderCalls = 0;
    const grader: StratifiedGrader = {
      grade: async () => {
        graderCalls++;
        return { judged: 'worse', reason: 'test' };
      },
    };
    const result = await runRollingReplay({
      samples,
      replayPair: makeReplayPair('identical response', 'identical response'),
      grader,
    });
    assert.equal(graderCalls, 0);
    assert.equal(result.verdict, 'pass_with_warning');
  });
});
