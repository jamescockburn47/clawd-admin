// test/lqcouncil-knowledge-drift.test.js — runKnowledgeDriftCheck integration.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test';

const { runKnowledgeDriftCheck, resetDriftStateForTests } = await import('../src/tasks/lqc-knowledge-drift.js');

function seedCheckout(dir, { roles = ['Proponent', 'Skeptic'], errorKinds = ['timeout'], roundMax = 4, timeoutSecs = 300 } = {}) {
  mkdirSync(join(dir, 'src', 'orchestrator'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  const rolesList = roles.join(', ');
  writeFileSync(join(dir, 'src', 'types.rs'), `pub enum Role { ${rolesList} }`);
  const kindsBody = errorKinds.map((k) => `kind: "${k}",`).join('\n');
  writeFileSync(join(dir, 'src', 'orchestrator', 'error_kind.rs'), kindsBody);
  writeFileSync(
    join(dir, 'src', 'orchestrator', 'state_machine.rs'),
    `for round in 0..=${roundMax} { run(round).await?; }`,
  );
  writeFileSync(join(dir, 'config', 'default.toml'), `timeout_secs = ${timeoutSecs}`);
}

describe('runKnowledgeDriftCheck', () => {
  let work;
  let checkout;
  let snapshotFile;
  let proposalsDir;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'lqc-drift-'));
    checkout = join(work, 'bot-council');
    snapshotFile = join(work, 'snapshot.json');
    proposalsDir = join(work, 'proposals');
    mkdirSync(checkout);
    resetDriftStateForTests();
  });

  afterEach(() => {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  });

  it('first run bootstraps a snapshot WITHOUT writing a proposal', async () => {
    seedCheckout(checkout);
    const result = await runKnowledgeDriftCheck({
      botCouncilDir: checkout,
      snapshotFile,
      proposalsDir,
      reason: 'test-first-run',
    });
    assert.equal(result.actionable.length, 0);
    assert.equal(result.proposalPath, null);
    assert.ok(existsSync(snapshotFile), 'baseline snapshot written');
    if (existsSync(proposalsDir)) {
      assert.deepEqual(readdirSync(proposalsDir), []);
    }
  });

  it('second run with no source change reports no drift', async () => {
    seedCheckout(checkout);
    await runKnowledgeDriftCheck({ botCouncilDir: checkout, snapshotFile, proposalsDir });
    const second = await runKnowledgeDriftCheck({ botCouncilDir: checkout, snapshotFile, proposalsDir });
    assert.deepEqual(second.changes, []);
    assert.equal(second.proposalPath, null);
  });

  it('detects added role and writes a proposal', async () => {
    seedCheckout(checkout);
    await runKnowledgeDriftCheck({ botCouncilDir: checkout, snapshotFile, proposalsDir });
    // simulate someone adding a new role
    seedCheckout(checkout, { roles: ['Proponent', 'Skeptic', 'Moderator'] });
    const result = await runKnowledgeDriftCheck({ botCouncilDir: checkout, snapshotFile, proposalsDir });

    assert.ok(result.actionable.length > 0);
    const roleChange = result.actionable.find((c) => c.field === 'roles');
    assert.ok(roleChange, 'expected a roles-field change');
    assert.deepEqual(roleChange.added, ['moderator']);
    assert.ok(result.proposalPath && existsSync(result.proposalPath), 'proposal file should exist');

    const proposal = JSON.parse(readFileSync(result.proposalPath, 'utf8'));
    assert.equal(proposal.type, 'lqc-knowledge-drift');
    assert.ok(proposal.recommended_action.length > 0);
    assert.ok(Array.isArray(proposal.changes));
  });

  it('detects scalar change in round count', async () => {
    seedCheckout(checkout);
    await runKnowledgeDriftCheck({ botCouncilDir: checkout, snapshotFile, proposalsDir });
    seedCheckout(checkout, { roundMax: 6 });
    const result = await runKnowledgeDriftCheck({ botCouncilDir: checkout, snapshotFile, proposalsDir });

    const scalar = result.actionable.find((c) => c.field === 'roundCount');
    assert.ok(scalar, 'expected roundCount drift');
    assert.equal(scalar.old, 5);
    assert.equal(scalar.new, 7);
  });
});
