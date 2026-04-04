// hooks/checks/silent-catch.mjs

// Matches catch blocks where the body is empty or whitespace-only
const BARE_CATCH_RE = /catch\s*\([^)]*\)\s*\{\s*\}/g;

/** @param {string} filePath @param {string} content @returns {{ warn: true, message: string } | null} */
export function checkSilentCatch(filePath, content) {
  if (!content.includes('catch')) return null;

  // Remove lines with intentional comments before checking
  const stripped = content.replace(/\/\/\s*intentional:.*$/gm, '____INTENTIONAL____');

  const matches = stripped.match(BARE_CATCH_RE);
  if (!matches || matches.length === 0) return null;

  return { warn: true, message: `${filePath}: ${matches.length} bare catch {} block(s). Add logging or // intentional: reason. Per CLAUDE.md.` };
}
