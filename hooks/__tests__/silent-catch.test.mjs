import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSilentCatch } from '../checks/silent-catch.mjs';

describe('checkSilentCatch', () => {
  it('warns on bare catch {}', () => {
    const result = checkSilentCatch('src/foo.js', 'try { x() } catch (e) {}');
    assert.ok(result.warn);
  });

  it('warns on catch with only whitespace', () => {
    const result = checkSilentCatch('src/foo.js', 'try { x() } catch (e) {\n  \n}');
    assert.ok(result.warn);
  });

  it('allows catch with intentional comment', () => {
    const result = checkSilentCatch('src/foo.js', 'catch (e) { // intentional: fire-and-forget }');
    assert.equal(result, null);
  });

  it('allows catch with logger call', () => {
    const result = checkSilentCatch('src/foo.js', 'catch (err) { logger.error(err); }');
    assert.equal(result, null);
  });

  it('returns null for files without catch', () => {
    const result = checkSilentCatch('src/foo.js', 'const x = 1;');
    assert.equal(result, null);
  });
});
