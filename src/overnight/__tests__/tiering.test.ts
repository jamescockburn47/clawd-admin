import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier, BANNED_FILES, type DiffSummary } from '../tiering.js';

describe('overnight/tiering', () => {
  describe('BANNED_FILES', () => {
    it('contains the files named in spec §4.4', () => {
      const expected = [
        'src/tasks/forge-orchestrator.js',
        'src/message-handler.js',
        'src/router.js',
        'src/cortex.js',
        'src/memory.js',
        'CLAUDE.md',
      ];
      for (const f of expected) assert.ok(BANNED_FILES.includes(f), `${f} should be banned`);
    });

    it('includes the docs/superpowers/** wildcard marker', () => {
      assert.ok(BANNED_FILES.some((f) => f.startsWith('docs/superpowers/')));
    });
  });

  describe('classifyTier', () => {
    it('Tier A: config/text/eval-labels only', () => {
      const diff: DiffSummary = {
        filesChanged: ['data/learned-eval-labels.json', 'src/prompt-templates/foo.txt'],
        linesChanged: 40,
      };
      assert.equal(classifyTier(diff).tier, 'A');
    });

    it('Tier B: source code within scope, no banned files', () => {
      const diff: DiffSummary = {
        filesChanged: ['src/overnight/report.ts', 'src/overnight/probe.ts'],
        linesChanged: 120,
      };
      assert.equal(classifyTier(diff).tier, 'B');
    });

    it('Tier C: exceeds file count', () => {
      const diff: DiffSummary = {
        filesChanged: [
          'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts',
        ],
        linesChanged: 50,
      };
      const result = classifyTier(diff);
      assert.equal(result.tier, 'C');
      assert.match(result.reason, /6 files.*max 5/);
    });

    it('Tier C: exceeds line count', () => {
      const diff: DiffSummary = {
        filesChanged: ['src/a.ts'],
        linesChanged: 200,
      };
      const result = classifyTier(diff);
      assert.equal(result.tier, 'C');
      assert.match(result.reason, /200 lines.*max 150/);
    });

    it('Tier C: touches a banned file', () => {
      const diff: DiffSummary = {
        filesChanged: ['src/overnight/report.ts', 'src/cortex.js'],
        linesChanged: 40,
      };
      const result = classifyTier(diff);
      assert.equal(result.tier, 'C');
      assert.match(result.reason, /banned.*src\/cortex\.js/);
    });

    it('Tier C: touches a docs/superpowers/ file', () => {
      const diff: DiffSummary = {
        filesChanged: ['docs/superpowers/specs/foo.md'],
        linesChanged: 10,
      };
      assert.equal(classifyTier(diff).tier, 'C');
    });

    it('Tier C: touches data/runtime/', () => {
      const diff: DiffSummary = {
        filesChanged: ['data/runtime/group-registry.json'],
        linesChanged: 5,
      };
      assert.equal(classifyTier(diff).tier, 'C');
    });
  });
});
