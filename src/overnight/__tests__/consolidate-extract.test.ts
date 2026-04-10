import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsolidateExtractor, type ExtractClient } from '../consolidate-extract.js';

describe('overnight/consolidate-extract.ConsolidateExtractor', () => {
  let tmpRoot: string;
  let logDir: string;
  let mockClient: ExtractClient;
  let capturedCalls: Array<{ conversation: string; source: string }>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-extract-'));
    logDir = join(tmpRoot, 'logs');
    mkdirSync(logDir);
    capturedCalls = [];
    mockClient = {
      extractCandidates: async (conversation: string, source: string) => {
        capturedCalls.push({ conversation, source });
        return {
          candidates: [
            {
              text: 'test memory',
              category: 'test',
              confidence: 0.9,
              sources: [{ hash: 'sha256:test', excerpt: conversation.slice(0, 20) }],
            },
          ],
        };
      },
    };
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('extracts candidates from each log file matching the date', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-a.jsonl'),
      JSON.stringify({ sender: 'James', text: 'hello world, this is a long enough message to pass the min length check' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'hi James', isBot: true }) + '\n',
    );
    writeFileSync(
      join(logDir, '2026-04-09-b.jsonl'),
      JSON.stringify({ sender: 'James', text: 'another conversation here with enough content' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'noted', isBot: true }) + '\n',
    );
    // Also a log from a different date that should be ignored.
    writeFileSync(
      join(logDir, '2026-04-08.jsonl'),
      JSON.stringify({ sender: 'James', text: 'old stuff' }) + '\n',
    );

    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');

    assert.equal(result.filesProcessed, 2);
    assert.equal(result.candidates.length, 2);
    assert.equal(capturedCalls.length, 2);
    assert.ok(capturedCalls[0]!.conversation.includes('hello world'));
    assert.ok(capturedCalls[1]!.conversation.includes('another conversation'));
  });

  it('returns empty result when no logs exist for the date', async () => {
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2099-01-01');
    assert.equal(result.filesProcessed, 0);
    assert.equal(result.candidates.length, 0);
    assert.equal(capturedCalls.length, 0);
  });

  it('skips files with less than 2 message lines', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-tiny.jsonl'),
      JSON.stringify({ sender: 'James', text: 'hi' }) + '\n',
    );
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 0);
    assert.equal(result.candidates.length, 0);
  });

  it('skips files whose assembled conversation is under 50 chars', async () => {
    writeFileSync(
      join(logDir, '2026-04-09-short.jsonl'),
      JSON.stringify({ sender: 'James', text: 'hi' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'ok', isBot: true }) + '\n',
    );
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 0);
  });

  it('continues when one file fails to parse', async () => {
    writeFileSync(join(logDir, '2026-04-09-ok.jsonl'),
      JSON.stringify({ sender: 'James', text: 'a valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'valid response', isBot: true }) + '\n',
    );
    writeFileSync(join(logDir, '2026-04-09-bad.jsonl'), 'not json at all\nnope\n');
    const extractor = new ConsolidateExtractor({ client: mockClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.file, /2026-04-09-bad\.jsonl/);
  });

  it('propagates EVO extract errors into the errors array and continues', async () => {
    writeFileSync(join(logDir, '2026-04-09-a.jsonl'),
      JSON.stringify({ sender: 'James', text: 'a valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'valid response', isBot: true }) + '\n',
    );
    writeFileSync(join(logDir, '2026-04-09-b.jsonl'),
      JSON.stringify({ sender: 'James', text: 'another valid line with enough text to process' }) + '\n' +
      JSON.stringify({ sender: 'Clint', text: 'response', isBot: true }) + '\n',
    );
    const failingClient: ExtractClient = {
      extractCandidates: async (_conversation, source) => {
        if (source.endsWith('-b')) throw new Error('evo timeout');
        return { candidates: [{ text: 't', category: 'c', confidence: 0.5, sources: [{ hash: 'h', excerpt: 'e' }] }] };
      },
    };
    const extractor = new ConsolidateExtractor({ client: failingClient, logDir });
    const result = await extractor.extractForDate('2026-04-09');
    assert.equal(result.filesProcessed, 1);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.reason, /evo timeout/);
  });
});
