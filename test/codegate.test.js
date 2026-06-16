// test/codegate.test.js
// Tests for src/moorstead/codegate.js — the mechanical safety gate.
// Pure module: no I/O, no side effects, no mocks needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange } from '../src/moorstead/codegate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a numstat line: "<added>\t<deleted>\t<path>" */
function line(added, deleted, path) {
  return `${added}\t${deleted}\t${path}`;
}

/** Single-file numstat */
function single(added, deleted, path) {
  return line(added, deleted, path);
}

// ── GREEN ─────────────────────────────────────────────────────────────────────

describe('classifyChange — GREEN', () => {
  it('1 small entities.js add → green', () => {
    const numstat = single(10, 2, 'src/entities.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'green');
    assert.equal(result.stats.files, 1);
    assert.equal(result.stats.added, 10);
    assert.equal(result.stats.deleted, 2);
    assert.ok(result.reasons.length > 0);
  });

  it('1 new file under src/ in explicit allowlist → green', () => {
    // Only explicit allowlist entries (entities.js, npc.js) are green.
    // A new src/*.js file lands amber unless added to greenAllowlist via opts.
    const numstat = single(20, 0, 'src/hedgehog.js');
    const result = classifyChange(numstat, { greenAllowlist: ['src/entities.js', 'src/npc.js', 'src/hedgehog.js'] });
    assert.equal(result.verdict, 'green');
  });

  it('1 new file under src/ not in allowlist → amber (not green, not red)', () => {
    const numstat = single(20, 0, 'src/hedgehog.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
  });

  it('npc.js small change → green', () => {
    const numstat = single(5, 3, 'src/npc.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'green');
  });

  it('exactly 2 files, 60 lines total → green (at boundary)', () => {
    const numstat = [
      line(30, 0, 'src/entities.js'),
      line(20, 10, 'src/npc.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'green');
    assert.equal(result.stats.files, 2);
    assert.equal(result.stats.added + result.stats.deleted, 60);
  });
});

// ── AMBER ─────────────────────────────────────────────────────────────────────

describe('classifyChange — AMBER', () => {
  it('npc.js + entities.js within caps but >60 lines → amber', () => {
    const numstat = [
      line(40, 0, 'src/npc.js'),
      line(35, 0, 'src/entities.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
    assert.ok(result.stats.files === 2);
    assert.ok(result.stats.added + result.stats.deleted === 75);
  });

  it('src/quests.js (outside green allowlist but not locked) → amber', () => {
    const numstat = single(20, 5, 'src/quests.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
  });

  it('src/milestones.js → amber', () => {
    const numstat = single(10, 0, 'src/milestones.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
  });

  it('src/ui.js → amber', () => {
    const numstat = single(15, 5, 'src/ui.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
  });

  it('3 safe files within line cap → amber (>2 files = not green, but ≤4 files = not red)', () => {
    const numstat = [
      line(5, 0, 'src/entities.js'),
      line(5, 0, 'src/npc.js'),
      line(5, 0, 'src/quests.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
    assert.equal(result.stats.files, 3);
  });

  it('amber result includes "requires explicit owner confirm" in reasons', () => {
    const numstat = single(20, 5, 'src/quests.js');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber');
    const reasons = result.reasons.join(' ');
    assert.match(reasons, /confirm/i);
  });
});

// ── RED — locked exact files ──────────────────────────────────────────────────

describe('classifyChange — RED: locked exact paths', () => {
  const lockedExact = [
    'src/worldgen.js',
    'src/geography.js',
    'src/noise.js',
    'src/sky.js',
    'src/landmarks.js',
    'src/rails.js',
    'src/defs.js',
    'src/multiplayer.js',
    'src/player.js',
    'package.json',
    'package-lock.json',
  ];

  for (const path of lockedExact) {
    it(`red for locked exact path: ${path}`, () => {
      const numstat = single(1, 0, path);
      const result = classifyChange(numstat);
      assert.equal(result.verdict, 'red', `Expected red for ${path}, got ${result.verdict}: ${result.reasons.join('; ')}`);
      const reasons = result.reasons.join(' ');
      assert.match(reasons, /locked/i);
    });
  }
});

// ── RED — locked pattern: auth/admin surface ──────────────────────────────────

describe('classifyChange — RED: auth/admin pattern paths', () => {
  const authyPaths = [
    'src/auth.js',
    'src/account.js',
    'src/login.js',
    'src/warden.js',
    'src/admin.js',
    'src/token.js',
    'src/secret.js',
    'src/password.js',
    'src/cred.js',
    'src/adminPanel.js',
    'src/loginHelper.js',
    'lib/auth-utils.js',
  ];

  for (const path of authyPaths) {
    it(`red for auth-y path: ${path}`, () => {
      const numstat = single(1, 0, path);
      const result = classifyChange(numstat);
      assert.equal(result.verdict, 'red', `Expected red for ${path}, got ${result.verdict}: ${result.reasons.join('; ')}`);
    });
  }
});

// ── RED — locked pattern: deploy/build infrastructure ─────────────────────────

describe('classifyChange — RED: deploy/build infrastructure paths', () => {
  const deployPaths = [
    'deploy/nginx.conf',
    '.github/workflows/ci.yml',
    'scripts/verify.sh',
    '.env',
    '.env.local',
    'some.service',
    'vite.config.js',
    'vite.config.ts',
    'vercel.json',
    '.vercelignore',
    'worldsvc/runner.py',
    'server/index.js',
  ];

  for (const path of deployPaths) {
    it(`red for deploy path: ${path}`, () => {
      const numstat = single(1, 0, path);
      const result = classifyChange(numstat);
      assert.equal(result.verdict, 'red', `Expected red for ${path}, got ${result.verdict}: ${result.reasons.join('; ')}`);
    });
  }
});

// ── RED — locked pattern: .py files ──────────────────────────────────────────

describe('classifyChange — RED: .py files', () => {
  it('red for any .py file', () => {
    const numstat = single(5, 0, 'src/runner.py');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'red');
  });

  it('red for worldsvc .py file', () => {
    const numstat = single(2, 0, 'worldsvc/generate.py');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'red');
  });
});

// ── RED — cap violations ──────────────────────────────────────────────────────

describe('classifyChange — RED: cap violations', () => {
  it('red when >4 files changed (5 safe files)', () => {
    const numstat = [
      line(5, 0, 'src/entities.js'),
      line(5, 0, 'src/npc.js'),
      line(5, 0, 'src/quests.js'),
      line(5, 0, 'src/milestones.js'),
      line(5, 0, 'src/ui.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'red');
    const reasons = result.reasons.join(' ');
    assert.match(reasons, /too many files/i);
  });

  it('red when exactly 5 files (boundary +1)', () => {
    const numstat = [
      line(1, 0, 'src/a.js'),
      line(1, 0, 'src/b.js'),
      line(1, 0, 'src/c.js'),
      line(1, 0, 'src/d.js'),
      line(1, 0, 'src/e.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'red');
  });

  it('red when >150 lines changed', () => {
    const numstat = single(100, 60, 'src/entities.js'); // 160 lines
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'red');
    const reasons = result.reasons.join(' ');
    assert.match(reasons, /too many lines/i);
  });

  it('red when exactly 151 lines (boundary +1)', () => {
    const numstat = single(100, 51, 'src/npc.js'); // 151 lines
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'red');
  });

  it('amber when exactly 150 lines (boundary, not red)', () => {
    // 150 lines across 2 non-green-allowlist files = amber (not red)
    const numstat = [
      line(75, 0, 'src/quests.js'),
      line(75, 0, 'src/milestones.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.equal(result.verdict, 'amber', `Expected amber at exactly 150 lines, got ${result.verdict}: ${result.reasons.join('; ')}`);
  });
});

// ── RED — empty / garbage input ───────────────────────────────────────────────

describe('classifyChange — RED: empty or garbage input', () => {
  it('red for empty string', () => {
    const result = classifyChange('');
    assert.equal(result.verdict, 'red');
    assert.match(result.reasons.join(' '), /no parseable diff/i);
  });

  it('red for null', () => {
    const result = classifyChange(null);
    assert.equal(result.verdict, 'red');
    assert.match(result.reasons.join(' '), /no parseable diff/i);
  });

  it('red for undefined', () => {
    const result = classifyChange(undefined);
    assert.equal(result.verdict, 'red');
  });

  it('red for whitespace only', () => {
    const result = classifyChange('   \n\n\t  ');
    assert.equal(result.verdict, 'red');
  });

  it('red for garbage that produces no parseable lines', () => {
    const result = classifyChange('this is not numstat output at all');
    assert.equal(result.verdict, 'red');
    assert.match(result.reasons.join(' '), /no parseable diff/i);
  });

  it('never throws for any input', () => {
    const inputs = [null, undefined, '', 42, {}, [], 'garbage\nmore garbage'];
    for (const input of inputs) {
      assert.doesNotThrow(() => classifyChange(input), `classifyChange threw for input: ${JSON.stringify(input)}`);
    }
  });
});

// ── opts overrides ─────────────────────────────────────────────────────────────

describe('classifyChange — opts overrides', () => {
  it('opts.maxFiles overrides default: maxFiles=2 → red for 3 files', () => {
    const numstat = [
      line(5, 0, 'src/entities.js'),
      line(5, 0, 'src/npc.js'),
      line(5, 0, 'src/quests.js'),
    ].join('\n');
    const result = classifyChange(numstat, { maxFiles: 2 });
    assert.equal(result.verdict, 'red');
    assert.match(result.reasons.join(' '), /too many files/i);
  });

  it('opts.maxLines overrides default: maxLines=20 → red for 30 lines', () => {
    const numstat = single(20, 10, 'src/entities.js'); // 30 lines
    const result = classifyChange(numstat, { maxLines: 20 });
    assert.equal(result.verdict, 'red');
    assert.match(result.reasons.join(' '), /too many lines/i);
  });

  it('opts.lockedExact overrides: empty locked list → worldgen.js becomes amber', () => {
    // Normally worldgen.js is hard-locked (red). With empty locked lists it becomes amber.
    const numstat = single(5, 0, 'src/worldgen.js');
    const result = classifyChange(numstat, { lockedExact: [], lockedPatterns: [] });
    // With no locked paths, worldgen.js is outside green allowlist → amber
    assert.notEqual(result.verdict, 'red');
    assert.equal(result.verdict, 'amber');
  });

  it('opts.lockedExact adds custom locked path → red', () => {
    const numstat = single(5, 0, 'src/entities.js');
    // Normally green; override to add entities.js to locked
    const result = classifyChange(numstat, { lockedExact: ['src/entities.js'], lockedPatterns: [] });
    assert.equal(result.verdict, 'red');
    assert.match(result.reasons.join(' '), /locked/i);
  });

  it('opts.lockedPatterns overrides: custom pattern blocks matching path', () => {
    const numstat = single(5, 0, 'src/hedgehog.js');
    // hedgehog.js is normally green; add a custom pattern to block it
    const result = classifyChange(numstat, { lockedExact: [], lockedPatterns: [/hedgehog/i] });
    assert.equal(result.verdict, 'red');
  });

  it('opts.greenAllowlist overrides: only quests.js is green-safe → entities.js goes amber', () => {
    // Replace the default allowlist with just quests.js; entities.js is no longer green
    const numstat = single(5, 0, 'src/entities.js');
    const result = classifyChange(numstat, { greenAllowlist: ['src/quests.js'] });
    // entities.js not in custom allowlist → amber
    assert.equal(result.verdict, 'amber');
  });

  it('opts.greenAllowlist overrides: lib/ file not in any allowlist → amber', () => {
    const numstat = single(5, 0, 'lib/entities.js');
    const result = classifyChange(numstat, { greenAllowlist: ['src/quests.js'], lockedExact: [], lockedPatterns: [] });
    // lib/entities.js is not in allowlist → amber
    assert.equal(result.verdict, 'amber');
  });

  it('opts.maxFiles=10 and opts.maxLines=500 → large change that would normally be red is now amber', () => {
    const numstat = [
      line(40, 10, 'src/quests.js'),
      line(40, 10, 'src/milestones.js'),
      line(40, 10, 'src/ui.js'),
      line(40, 10, 'src/train.js'),
      line(40, 10, 'src/textures.js'),
    ].join('\n'); // 5 files, 250 lines — normally red (>4 files, >150 lines)
    const result = classifyChange(numstat, { maxFiles: 10, maxLines: 500 });
    assert.equal(result.verdict, 'amber');
  });
});

// ── stats shape ───────────────────────────────────────────────────────────────

describe('classifyChange — stats shape', () => {
  it('stats.paths contains all changed paths', () => {
    const numstat = [
      line(10, 0, 'src/entities.js'),
      line(5, 2, 'src/npc.js'),
    ].join('\n');
    const result = classifyChange(numstat);
    assert.deepEqual(result.stats.paths.sort(), ['src/entities.js', 'src/npc.js'].sort());
  });

  it('binary files (- lines) contribute 0 to added/deleted count', () => {
    const numstat = single('-', '-', 'src/entities.js');
    const result = classifyChange(numstat);
    // Binary file contributes 0 lines; path is in green allowlist → green
    assert.equal(result.stats.added, 0);
    assert.equal(result.stats.deleted, 0);
    assert.equal(result.verdict, 'green');
  });
});
