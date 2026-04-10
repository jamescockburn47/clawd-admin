// @ts-check
// src/overnight/paths.js — runtime-state path resolution with seed fallback.
// Spec: docs/superpowers/specs/2026-04-10-compound-dream-overnight-design.md §6.1 P1.
//
// Runtime state files live in data/runtime/ (gitignored, live-bot writes).
// On first read, if the runtime file is missing, it is seeded from
// data/runtime-defaults/<flattened-name>. This lets a fresh clone boot
// without needing an external seed script.
//
// Written as plain JS (not TS) so that existing test/*.test.js files that
// re-import src/group-registry.js via file:// URLs with cache-buster query
// strings can still resolve the import chain. tsx's .js→.ts rewriting does
// not handle file:// URL imports with query strings reliably.

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// src/overnight/paths.js → repo root is two dirs up.
const REPO_ROOT = resolve(MODULE_DIR, '..', '..');

const DEFAULT_RUNTIME_DIR = join(REPO_ROOT, 'data', 'runtime');
const DEFAULT_DEFAULTS_DIR = join(REPO_ROOT, 'data', 'runtime-defaults');

/**
 * @typedef {Object} RuntimePathOptions
 * @property {string} [runtimeDir]
 * @property {string} [defaultsDir]
 */

/**
 * Resolve the on-disk path for a runtime-state file, seeding from defaults if missing.
 *
 * @param {string} name Logical file name relative to data/runtime/, e.g. "group-registry.json"
 *                      or "system-knowledge/meta.json". Nested names map to a flattened default
 *                      filename (slashes replaced with "-") in data/runtime-defaults/.
 * @param {RuntimePathOptions} [opts] Override directories (for tests). Defaults point at the repo.
 * @returns {string} Absolute path to the runtime file. If it did not exist, it has now been seeded.
 * @throws {Error} If neither the runtime file nor a matching default exists.
 */
export function runtimePath(name, opts = {}) {
  const runtimeDir = opts.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const defaultsDir = opts.defaultsDir ?? DEFAULT_DEFAULTS_DIR;

  const runtimeFile = join(runtimeDir, name);
  if (existsSync(runtimeFile)) return runtimeFile;

  const flattenedName = name.replace(/\//g, '-');
  const defaultFile = join(defaultsDir, flattenedName);
  if (!existsSync(defaultFile)) {
    throw new Error(
      `runtimePath: no default at ${defaultFile} to seed ${runtimeFile} from`,
    );
  }

  mkdirSync(dirname(runtimeFile), { recursive: true });
  copyFileSync(defaultFile, runtimeFile);
  return runtimeFile;
}
