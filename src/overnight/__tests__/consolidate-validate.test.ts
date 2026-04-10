import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCandidate,
  type MemoryCandidate,
  type MemorySource,
  MAX_EXCERPT_CHARS,
} from '../consolidate-validate.js';

describe('overnight/consolidate-validate.validateCandidate', () => {
  const sources: MemorySource[] = [
    { hash: 'sha256:abc123', excerpt: 'James said the deadline is next Tuesday' },
  ];

  function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
    return {
      text: 'James has a deadline next Tuesday',
      category: 'project',
      confidence: 0.8,
      sources,
      ...overrides,
    };
  }

  it('accepts a candidate with all required fields and at least one source', () => {
    const result = validateCandidate(makeCandidate());
    assert.equal(result.valid, true);
    assert.equal(result.reason, undefined);
  });

  it('rejects a candidate with missing sources field', () => {
    const candidate = { ...makeCandidate(), sources: undefined as unknown as MemorySource[] };
    const result = validateCandidate(candidate);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /no_evidence|missing.*sources/i);
  });

  it('rejects a candidate with an empty sources array', () => {
    const result = validateCandidate(makeCandidate({ sources: [] }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /no_evidence/i);
  });

  it('rejects a source missing the hash field', () => {
    const badSources = [{ excerpt: 'hi' }] as unknown as MemorySource[];
    const result = validateCandidate(makeCandidate({ sources: badSources }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /hash/i);
  });

  it('rejects a source missing the excerpt field', () => {
    const badSources = [{ hash: 'sha256:x' }] as unknown as MemorySource[];
    const result = validateCandidate(makeCandidate({ sources: badSources }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /excerpt/i);
  });

  it('rejects a source whose excerpt exceeds MAX_EXCERPT_CHARS', () => {
    const longExcerpt = 'x'.repeat(MAX_EXCERPT_CHARS + 1);
    const result = validateCandidate(
      makeCandidate({ sources: [{ hash: 'sha256:y', excerpt: longExcerpt }] }),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /excerpt.*too long|exceeds/i);
  });

  it('rejects a candidate with empty text', () => {
    const result = validateCandidate(makeCandidate({ text: '' }));
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /text/i);
  });

  it('rejects a candidate with missing category', () => {
    const candidate = { ...makeCandidate(), category: undefined as unknown as string };
    const result = validateCandidate(candidate);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /category/i);
  });

  it('rejects a candidate with confidence outside [0, 1]', () => {
    const tooLow = validateCandidate(makeCandidate({ confidence: -0.1 }));
    const tooHigh = validateCandidate(makeCandidate({ confidence: 1.5 }));
    assert.equal(tooLow.valid, false);
    assert.equal(tooHigh.valid, false);
  });

  it('accepts a candidate with multiple sources', () => {
    const result = validateCandidate(
      makeCandidate({
        sources: [
          { hash: 'sha256:a', excerpt: 'first' },
          { hash: 'sha256:b', excerpt: 'second' },
        ],
      }),
    );
    assert.equal(result.valid, true);
  });
});
