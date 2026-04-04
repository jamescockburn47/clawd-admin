// hooks/checks/process-env.mjs
import { basename } from 'node:path';

const CONFIG_FILES = new Set(['config.js', 'config.ts', 'config.mjs']);
const PROCESS_ENV_RE = /process\.env\b/;

/** @param {string} filePath @param {string} content @returns {{ warn: true, message: string } | null} */
export function checkProcessEnv(filePath, content) {
  const normalised = filePath.replace(/\\/g, '/');
  if (!normalised.includes('src/')) return null;
  if (normalised.includes('test/')) return null;
  if (CONFIG_FILES.has(basename(normalised))) return null;
  if (!PROCESS_ENV_RE.test(content)) return null;

  return { warn: true, message: `${filePath}: process.env used outside config. Move to config.js per CLAUDE.md.` };
}
