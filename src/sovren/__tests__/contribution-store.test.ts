/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContributionStore } from '../contribution-store.js';
import type { XlsxStructure, MethodologyContribution } from '../types.js';

async function tempStore(): Promise<{ store: ContributionStore; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sovren-store-'));
  const store = new ContributionStore({ rootDir: root });
  return { store, root };
}

function fakeXlsxStructure(): XlsxStructure {
  return {
    fileName: 'fake.xlsx',
    fileHash: 'abc123',
    sheetCount: 1,
    sheets: [
      {
        name: 'Sheet1',
        rowCount: 2,
        columnCount: 1,
        cells: [
          {
            address: 'A1',
            row: 1,
            column: 1,
            value: 'hello',
            formula: null,
            type: 'string',
            numberFormat: null,
          },
        ],
        mergedRanges: [],
      },
    ],
    definedNames: [],
    parsedAt: '2026-04-11T22:00:00.000Z',
  };
}

function fakeMethodology(): MethodologyContribution {
  return {
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T22:00:00.000Z',
    sourceKind: 'xlsx',
    sourceFiles: [{ fileName: 'fake.xlsx', fileHash: 'abc123' }],
    variables: [
      { name: 'IRR', definition: '15% purchaser hurdle', sourceCells: ['Sheet1!B5'], domain: 'percent' },
    ],
    formulas: [],
    anchors: [],
    workedExamples: [],
    openQuestions: ['What is the weighting?'],
    conflicts: [],
    suggestedLinks: ['backend/app/services/valuation/calculator.py'],
    shortDescription: 'Test contribution',
  };
}

test('store creates directory tree and index for an xlsx contribution', async () => {
  const { store, root } = await tempStore();
  const buffer = Buffer.from('fake xlsx bytes');
  const entry = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T22:00:00.000Z',
    kind: 'xlsx',
    shortDescription: 'Test contribution',
    coverText: 'cover',
    xlsxStructure: fakeXlsxStructure(),
    xlsxBuffer: buffer,
    methodology: fakeMethodology(),
  });

  assert.equal(entry.contributorSlug, 'peter');
  assert.match(entry.id, /^peter\/2026-04-11-test-contribution$/);

  const dir = path.join(root, entry.id);
  const files = await fs.readdir(dir);
  assert.ok(files.includes('fake.xlsx'));
  assert.ok(files.includes('xlsx-structure.json'));
  assert.ok(files.includes('methodology.json'));
  assert.ok(files.includes('methodology.md'));
  assert.ok(files.includes('cover.md'));
  assert.ok(files.includes('links.json'));

  // links.json carries suggestedLinks from the methodology
  const links = JSON.parse(await fs.readFile(path.join(dir, 'links.json'), 'utf-8'));
  assert.deepEqual(links.affects, ['backend/app/services/valuation/calculator.py']);

  // index round-trips
  const reload = await store.loadIndex();
  assert.equal(reload.contributions.length, 1);
  assert.equal(reload.contributions[0]!.id, entry.id);
});

test('store deduplicates by file hash', async () => {
  const { store } = await tempStore();
  const buffer = Buffer.from('fake xlsx bytes');
  const first = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T22:00:00.000Z',
    kind: 'xlsx',
    shortDescription: 'first',
    xlsxStructure: fakeXlsxStructure(),
    xlsxBuffer: buffer,
  });
  const second = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T23:00:00.000Z',
    kind: 'xlsx',
    shortDescription: 'second attempt with same file',
    xlsxStructure: fakeXlsxStructure(),
    xlsxBuffer: buffer,
  });
  assert.equal(first.id, second.id);
  const reload = await store.loadIndex();
  assert.equal(reload.contributions.length, 1);
});

test('store records extraction failure marker when methodology missing', async () => {
  const { store, root } = await tempStore();
  const entry = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T22:00:00.000Z',
    kind: 'text',
    shortDescription: 'failed extraction case',
    coverText: 'some text body',
    extractionError: 'invalid_json',
    rawModelOutput: '{ broken',
  });
  const dir = path.join(root, entry.id);
  const files = await fs.readdir(dir);
  assert.ok(files.includes('extraction-failed.txt'));
  assert.ok(!files.includes('methodology.json'));
});

test('store setStatus updates an existing entry', async () => {
  const { store } = await tempStore();
  const entry = await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T22:00:00.000Z',
    kind: 'text',
    shortDescription: 'pending entry',
    coverText: 'body',
    status: 'pending',
  });
  const ok = await store.setStatus(entry.id, 'incorporated');
  assert.equal(ok, true);
  const reload = await store.loadIndex();
  assert.equal(reload.contributions[0]!.status, 'incorporated');
});

test('store findByAffects matches via parent path', async () => {
  const { store } = await tempStore();
  await store.addContribution({
    contributor: 'Peter',
    contributorSlug: 'peter',
    receivedAt: '2026-04-11T22:00:00.000Z',
    kind: 'text',
    shortDescription: 'affects valuation',
    coverText: 'body',
    methodology: {
      ...fakeMethodology(),
      suggestedLinks: ['backend/app/services/valuation'],
    },
  });
  const hits = await store.findByAffects('backend/app/services/valuation/calculator.py');
  assert.equal(hits.length, 1);
});
