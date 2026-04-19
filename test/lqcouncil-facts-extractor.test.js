// test/lqcouncil-facts-extractor.test.js — parse bot-council source → facts.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const {
  parseRolesFromTypes,
  parseErrorKinds,
  parseRoundCount,
  parseRoundTimeoutSeconds,
  extractFactsFromCheckout,
  diffSnapshots,
} = await import('../src/lqcouncil/facts-extractor.js');

describe('parseRolesFromTypes', () => {
  it('extracts the five current roles in source order as snake_case', () => {
    const source = `
      #[derive(Debug)]
      pub enum Role {
        Proponent,
        Skeptic,
        DevilsAdvocate,
        Empiricist,
        Steelman,
      }
    `;
    assert.deepEqual(parseRolesFromTypes(source), [
      'proponent', 'skeptic', 'devils_advocate', 'empiricist', 'steelman',
    ]);
  });

  it('returns empty when no Role enum is present', () => {
    assert.deepEqual(parseRolesFromTypes('pub struct Other {}'), []);
  });

  it('tolerates line comments between variants', () => {
    const source = `pub enum Role {
      Proponent, // strong case
      Skeptic,
    }`;
    assert.deepEqual(parseRolesFromTypes(source), ['proponent', 'skeptic']);
  });

  it('detects a new role added between existing ones', () => {
    const source = `pub enum Role {
      Proponent,
      Skeptic,
      Moderator,
      DevilsAdvocate,
      Empiricist,
      Steelman,
    }`;
    assert.deepEqual(parseRolesFromTypes(source), [
      'proponent', 'skeptic', 'moderator', 'devils_advocate', 'empiricist', 'steelman',
    ]);
  });
});

describe('parseErrorKinds', () => {
  it('collects unique kind: "…" literals', () => {
    const source = `
      return ErrorClassification { kind: "timeout", detail: "x".into() };
      return ErrorClassification { kind: "http_5xx", detail: format!("HTTP {}", s) };
      return ErrorClassification { kind: "timeout", detail: "y".into() }; // dup
    `;
    assert.deepEqual(parseErrorKinds(source), ['http_5xx', 'timeout']);
  });

  it('returns empty when no literals present', () => {
    assert.deepEqual(parseErrorKinds('// no kinds here'), []);
  });
});

describe('parseRoundCount', () => {
  it('converts `0..=4` to round count 5', () => {
    assert.equal(parseRoundCount('for round in 0..=4 {'), 5);
  });

  it('detects a 7-round expansion', () => {
    assert.equal(parseRoundCount('for round in 0..=6 {'), 7);
  });

  it('returns null when pattern missing', () => {
    assert.equal(parseRoundCount('fn run() {}'), null);
  });
});

describe('parseRoundTimeoutSeconds', () => {
  it('reads config.toml style decl', () => {
    assert.equal(parseRoundTimeoutSeconds('timeout_secs = 300'), 300);
  });

  it('reads rust const', () => {
    assert.equal(parseRoundTimeoutSeconds('const DEFAULT_TIMEOUT_SECS: u64 = 180;'), 180);
  });
});

describe('extractFactsFromCheckout', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lqc-facts-'));
    mkdirSync(join(tmpDir, 'src', 'orchestrator'), { recursive: true });
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src', 'types.rs'),
      'pub enum Role { Proponent, Skeptic, DevilsAdvocate, Empiricist, Steelman }',
    );
    writeFileSync(
      join(tmpDir, 'src', 'orchestrator', 'error_kind.rs'),
      'kind: "timeout", kind: "http_5xx", kind: "internal"',
    );
    writeFileSync(
      join(tmpDir, 'src', 'orchestrator', 'state_machine.rs'),
      'for round in 0..=4 { run_round(round).await?; }',
    );
    writeFileSync(join(tmpDir, 'config', 'default.toml'), 'timeout_secs = 300');
  });

  after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it('pulls all four facts from a realistic checkout', () => {
    const snap = extractFactsFromCheckout(tmpDir);
    assert.equal(snap.sourceAvailable, true);
    assert.deepEqual(snap.roles, ['proponent', 'skeptic', 'devils_advocate', 'empiricist', 'steelman']);
    assert.deepEqual(snap.errorKinds, ['http_5xx', 'internal', 'timeout']);
    assert.equal(snap.roundCount, 5);
    assert.equal(snap.roundTimeoutSeconds, 300);
  });

  it('flags sourceAvailable=false when directory is missing', () => {
    const snap = extractFactsFromCheckout(join(tmpDir, 'does-not-exist'));
    assert.equal(snap.sourceAvailable, false);
  });
});

describe('diffSnapshots', () => {
  const baseline = {
    sourceAvailable: true,
    repoRoot: '/x',
    roles: ['proponent', 'skeptic'],
    errorKinds: ['timeout', 'internal'],
    roundCount: 5,
    roundTimeoutSeconds: 300,
  };

  it('reports initial-snapshot when no prior exists', () => {
    const out = diffSnapshots(null, baseline);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'initial-snapshot');
  });

  it('returns empty array when snapshots are identical', () => {
    assert.deepEqual(diffSnapshots(baseline, baseline), []);
  });

  it('flags role added + error kind removed', () => {
    const next = { ...baseline, roles: ['proponent', 'skeptic', 'moderator'], errorKinds: ['timeout'] };
    const out = diffSnapshots(baseline, next);
    const roles = out.find((c) => c.field === 'roles');
    const errs = out.find((c) => c.field === 'errorKinds');
    assert.deepEqual(roles.added, ['moderator']);
    assert.deepEqual(errs.removed, ['internal']);
  });

  it('flags scalar change in round count', () => {
    const next = { ...baseline, roundCount: 7 };
    const out = diffSnapshots(baseline, next);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'scalar-diff');
    assert.equal(out[0].field, 'roundCount');
    assert.equal(out[0].old, 5);
    assert.equal(out[0].new, 7);
  });
});
