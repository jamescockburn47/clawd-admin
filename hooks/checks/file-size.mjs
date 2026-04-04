// hooks/checks/file-size.mjs
import { extname } from 'node:path';

const LIMITS = { '.js': 300, '.ts': 300, '.mjs': 300, '.py': 500 };

/** @param {string} filePath @param {string} content @returns {{ warn: true, message: string } | null} */
export function checkFileSize(filePath, content) {
  const ext = extname(filePath);
  const limit = LIMITS[ext];
  if (!limit) return null;

  const lines = content.split('\n').length;
  if (lines <= limit) return null;

  return { warn: true, message: `${filePath}: ${lines} lines (limit: ${limit}). Split by responsibility per CLAUDE.md.` };
}
