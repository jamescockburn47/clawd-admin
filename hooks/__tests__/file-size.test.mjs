import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkFileSize } from '../checks/file-size.mjs';

describe('checkFileSize', () => {
  it('returns warning for JS file over 300 lines', () => {
    const result = checkFileSize('/fake/big.js', 'a\n'.repeat(350));
    assert.ok(result.warn);
    assert.match(result.message, /351.*300/);
  });

  it('returns null for JS file under 300 lines', () => {
    const result = checkFileSize('/fake/small.js', 'a\n'.repeat(100));
    assert.equal(result, null);
  });

  it('uses 500-line limit for Python files', () => {
    const result = checkFileSize('/fake/ok.py', 'a\n'.repeat(400));
    assert.equal(result, null);
  });

  it('warns for Python file over 500 lines', () => {
    const result = checkFileSize('/fake/big.py', 'a\n'.repeat(550));
    assert.ok(result.warn);
    assert.match(result.message, /551.*500/);
  });

  it('ignores non-code files', () => {
    const result = checkFileSize('/fake/data.json', 'a\n'.repeat(9999));
    assert.equal(result, null);
  });
});
