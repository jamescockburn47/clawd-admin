import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runImplementStage,
  type ClaudeCliClient,
  type ImplementOptions,
} from '../improve-implement.js';
import type { FinalCandidate } from '../improve-synthesis.js';

function makeCandidate(): FinalCandidate {
  return {
    id: 'c1',
    title: 'Cap cortex gather timeout at 15s',
    category: 'performance',
    scope: 'src/cortex.js',
    evidence_refs: ['pattern:cortex_slow', 'quality_failure:slow_cortex'],
    predicted_benefit: 'planning p95 from 87s to 20s',
  };
}

function makeCli(stdout: string = 'done', exitCode = 0): ClaudeCliClient {
  return {
    runSession: async () => ({ stdout, stderr: '', exitCode }),
  };
}

describe('overnight/improve-implement.runImplementStage (skipWorktree)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-impl-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Mock execFn that returns whatever we configure, by command prefix. */
  function makeExec(responses: Record<string, { stdout: string; code?: number }>): ImplementOptions['execFn'] {
    return async (cmd) => {
      for (const [prefix, resp] of Object.entries(responses)) {
        if (cmd.includes(prefix)) {
          if (resp.code && resp.code !== 0) {
            const err = new Error(`exit ${resp.code}`) as Error & { code?: number; stdout?: string; stderr?: string };
            err.code = resp.code;
            err.stdout = resp.stdout;
            err.stderr = '';
            throw err;
          }
          return { stdout: resp.stdout, stderr: '' };
        }
      }
      return { stdout: '', stderr: '' };
    };
  }

  it('returns ok when all three artefacts are non-empty and tests pass', async () => {
    const result = await runImplementStage({
      candidate: makeCandidate(),
      repoRoot: tmpRoot,
      client: makeCli(),
      skipWorktree: true,
      execFn: makeExec({
        'git log': { stdout: 'abc123 feat: cap cortex timeout\n' },
        'git diff': { stdout: ' src/cortex.js | 20 ++++++++++--------\n' },
        'npm test': { stdout: 'all tests passed\nsuites: 10\npass: 42\nfail: 0\n' },
        'git rev-parse': { stdout: 'forge/wt-test\n' },
      }),
    });
    assert.equal(result.verdict, 'ok');
    assert.match(result.reason, /consistent/);
    assert.equal(result.artifacts.testExitCode, 0);
    assert.ok(result.artifacts.gitLog.includes('abc123'));
  });

  it('fails when git log is empty (no commits made)', async () => {
    const result = await runImplementStage({
      candidate: makeCandidate(),
      repoRoot: tmpRoot,
      client: makeCli(),
      skipWorktree: true,
      execFn: makeExec({
        'git log': { stdout: '' },
        'git diff': { stdout: 'some diff' },
        'npm test': { stdout: 'tests passed' },
      }),
    });
    assert.equal(result.verdict, 'failed');
    assert.match(result.reason, /no commits/);
  });

  it('fails when git diff is empty', async () => {
    const result = await runImplementStage({
      candidate: makeCandidate(),
      repoRoot: tmpRoot,
      client: makeCli(),
      skipWorktree: true,
      execFn: makeExec({
        'git log': { stdout: 'abc commit' },
        'git diff': { stdout: '' },
        'npm test': { stdout: 'passed' },
      }),
    });
    assert.equal(result.verdict, 'failed');
    assert.match(result.reason, /no code changes/);
  });

  it('fails when tests fail with non-zero exit', async () => {
    const result = await runImplementStage({
      candidate: makeCandidate(),
      repoRoot: tmpRoot,
      client: makeCli(),
      skipWorktree: true,
      execFn: makeExec({
        'git log': { stdout: 'abc commit' },
        'git diff': { stdout: 'some diff' },
        'npm test': { stdout: 'some output', code: 1 },
      }),
    });
    assert.equal(result.verdict, 'failed');
    assert.match(result.reason, /npm test exited 1/);
  });

  it('fails when npm test stdout is empty (tests did not run)', async () => {
    const result = await runImplementStage({
      candidate: makeCandidate(),
      repoRoot: tmpRoot,
      client: makeCli(),
      skipWorktree: true,
      execFn: makeExec({
        'git log': { stdout: 'abc commit' },
        'git diff': { stdout: 'some diff' },
        'npm test': { stdout: '' },
      }),
    });
    assert.equal(result.verdict, 'failed');
    assert.match(result.reason, /stdout empty/);
  });

  it('propagates the Claude CLI stdout/stderr into artifacts', async () => {
    const result = await runImplementStage({
      candidate: makeCandidate(),
      repoRoot: tmpRoot,
      client: {
        runSession: async () => ({
          stdout: 'claude session log here',
          stderr: 'warning about something',
          exitCode: 0,
        }),
      },
      skipWorktree: true,
      execFn: makeExec({
        'git log': { stdout: 'abc commit' },
        'git diff': { stdout: 'diff' },
        'npm test': { stdout: 'passed' },
      }),
    });
    assert.equal(result.artifacts.claudeStdout, 'claude session log here');
    assert.equal(result.artifacts.claudeStderr, 'warning about something');
  });
});
