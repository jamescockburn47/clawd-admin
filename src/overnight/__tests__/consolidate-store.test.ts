import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsolidateStore, type StoreClient, type StoreResult } from '../consolidate-store.js';
import type { MemoryCandidate } from '../consolidate-validate.js';

describe('overnight/consolidate-store.ConsolidateStore', () => {
  let tmpRoot: string;
  let overnightDir: string;
  let storedEntries: MemoryCandidate[];
  let failingStoreOn: string | null;
  let mockClient: StoreClient;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-store-'));
    overnightDir = join(tmpRoot, 'overnight');
    storedEntries = [];
    failingStoreOn = null;
    mockClient = {
      storeValidated: async (candidate: MemoryCandidate) => {
        if (failingStoreOn && candidate.text.includes(failingStoreOn)) {
          throw new Error(`store failed for ${candidate.text}`);
        }
        storedEntries.push(candidate);
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function valid(text: string): MemoryCandidate {
    return {
      text,
      category: 'test',
      confidence: 0.8,
      sources: [{ hash: 'sha256:h', excerpt: text.slice(0, 50) }],
    };
  }

  function invalid(text: string): MemoryCandidate {
    return {
      text,
      category: 'test',
      confidence: 0.8,
      sources: [] as MemoryCandidate['sources'],
    };
  }

  it('stores all validated candidates and writes none to rejected log', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result: StoreResult = await store.process({
      candidates: [valid('memory A'), valid('memory B'), valid('memory C')],
      date: '2026-04-10',
    });

    assert.equal(result.stored, 3);
    assert.equal(result.rejected, 0);
    assert.equal(storedEntries.length, 3);
    assert.ok(!existsSync(join(overnightDir, 'rejected-2026-04-10.jsonl')));
  });

  it('writes invalid candidates to rejected-<date>.jsonl and stores valid ones', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result = await store.process({
      candidates: [valid('memory A'), invalid('bad one'), valid('memory B')],
      date: '2026-04-10',
    });

    assert.equal(result.stored, 2);
    assert.equal(result.rejected, 1);
    assert.equal(storedEntries.length, 2);

    const rejectedFile = join(overnightDir, 'rejected-2026-04-10.jsonl');
    assert.ok(existsSync(rejectedFile));
    const lines = readFileSync(rejectedFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.candidate.text, 'bad one');
    assert.match(parsed.reason, /no_evidence/);
    assert.ok(parsed.timestamp);
  });

  it('records store failures in the store_errors field and still processes other candidates', async () => {
    failingStoreOn = 'will fail';
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result = await store.process({
      candidates: [valid('ok one'), valid('will fail'), valid('another ok')],
      date: '2026-04-10',
    });

    assert.equal(result.stored, 2);
    assert.equal(result.rejected, 0);
    assert.equal(result.storeErrors.length, 1);
    assert.match(result.storeErrors[0]!.reason, /store failed/);
  });

  it('appends to an existing rejected log without overwriting', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    await store.process({ candidates: [invalid('first bad')], date: '2026-04-10' });
    await store.process({ candidates: [invalid('second bad')], date: '2026-04-10' });

    const rejectedFile = join(overnightDir, 'rejected-2026-04-10.jsonl');
    const lines = readFileSync(rejectedFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).candidate.text, 'first bad');
    assert.equal(JSON.parse(lines[1]!).candidate.text, 'second bad');
  });

  it('handles an empty candidate list cleanly', async () => {
    const store = new ConsolidateStore({ client: mockClient, overnightDir });
    const result = await store.process({ candidates: [], date: '2026-04-10' });
    assert.equal(result.stored, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.storeErrors.length, 0);
  });
});
