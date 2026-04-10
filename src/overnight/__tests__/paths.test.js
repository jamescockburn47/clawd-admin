// Phase 0 tests for runtime-path seeding.
// Plain JS to match paths.js (see paths.js header for rationale).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimePath } from '../paths.js';

describe('overnight/paths.runtimePath', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'compound-dream-paths-'));
    mkdirSync(join(tmpRoot, 'runtime'));
    mkdirSync(join(tmpRoot, 'runtime-defaults'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the runtime file path when it already exists', () => {
    const runtimeFile = join(tmpRoot, 'runtime', 'group-registry.json');
    writeFileSync(runtimeFile, '{"groups":{}}', 'utf8');

    const result = runtimePath('group-registry.json', {
      runtimeDir: join(tmpRoot, 'runtime'),
      defaultsDir: join(tmpRoot, 'runtime-defaults'),
    });

    assert.equal(result, runtimeFile);
    assert.equal(readFileSync(result, 'utf8'), '{"groups":{}}');
  });

  it('seeds the runtime file from defaults when missing', () => {
    const defaultFile = join(tmpRoot, 'runtime-defaults', 'group-registry.json');
    writeFileSync(defaultFile, '{"groups":{"seed":true}}', 'utf8');

    const result = runtimePath('group-registry.json', {
      runtimeDir: join(tmpRoot, 'runtime'),
      defaultsDir: join(tmpRoot, 'runtime-defaults'),
    });

    assert.equal(result, join(tmpRoot, 'runtime', 'group-registry.json'));
    assert.ok(existsSync(result), 'runtime file should now exist');
    assert.equal(readFileSync(result, 'utf8'), '{"groups":{"seed":true}}');
  });

  it('throws a clear error when neither runtime nor defaults exist', () => {
    assert.throws(
      () => runtimePath('nonexistent.json', {
        runtimeDir: join(tmpRoot, 'runtime'),
        defaultsDir: join(tmpRoot, 'runtime-defaults'),
      }),
      /no default at .*nonexistent\.json/,
    );
  });

  it('supports nested names like system-knowledge/meta.json', () => {
    const defaultFile = join(tmpRoot, 'runtime-defaults', 'system-knowledge-meta.json');
    writeFileSync(defaultFile, '{"version":1}', 'utf8');

    const result = runtimePath('system-knowledge/meta.json', {
      runtimeDir: join(tmpRoot, 'runtime'),
      defaultsDir: join(tmpRoot, 'runtime-defaults'),
    });

    assert.equal(result, join(tmpRoot, 'runtime', 'system-knowledge', 'meta.json'));
    assert.equal(readFileSync(result, 'utf8'), '{"version":1}');
  });
});
