import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowSink } from '../consolidate-shadow-sink.js';
import type { MemoryCandidate } from '../consolidate-validate.js';

describe('overnight/consolidate-shadow-sink.ShadowSink', () => {
  let tmpRoot: string;
  let overnightDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-shadow-sink-'));
    overnightDir = join(tmpRoot, 'overnight');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeCandidate(text: string): MemoryCandidate {
    return {
      text,
      category: 'project',
      confidence: 0.85,
      sources: [{ hash: 'sha256:conv:abc', excerpt: text.slice(0, 50) }],
    };
  }

  it('writes exactly one JSONL line per storeValidated call', async () => {
    const sink = new ShadowSink({ overnightDir, todayStr: '2026-04-10' });
    await sink.storeValidated(makeCandidate('memory A'));

    const file = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    assert.ok(existsSync(file));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.candidate.text, 'memory A');
    assert.ok(parsed.timestamp);
  });

  it('appends to an existing file instead of overwriting', async () => {
    const sink = new ShadowSink({ overnightDir, todayStr: '2026-04-10' });
    await sink.storeValidated(makeCandidate('first'));
    await sink.storeValidated(makeCandidate('second'));
    await sink.storeValidated(makeCandidate('third'));

    const file = join(overnightDir, 'shadow-candidates-2026-04-10.jsonl');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]!).candidate.text, 'first');
    assert.equal(JSON.parse(lines[1]!).candidate.text, 'second');
    assert.equal(JSON.parse(lines[2]!).candidate.text, 'third');
  });

  it('creates the overnight directory if it does not already exist', async () => {
    assert.ok(!existsSync(overnightDir));
    const sink = new ShadowSink({ overnightDir, todayStr: '2026-04-10' });
    await sink.storeValidated(makeCandidate('first'));
    assert.ok(existsSync(overnightDir));
  });

  it('uses the configured date in the filename', async () => {
    const sink = new ShadowSink({ overnightDir, todayStr: '2099-12-31' });
    await sink.storeValidated(makeCandidate('future memory'));
    assert.ok(existsSync(join(overnightDir, 'shadow-candidates-2099-12-31.jsonl')));
  });
});
