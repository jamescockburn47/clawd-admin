// hooks/post-edit-checks.mjs
// PostToolUse hook — runs after Edit/Write/MultiEdit
// Reads stdin JSON from Claude Code, checks the edited file against standards.
// Warnings go to stderr. Always exits 0 (warn, never block).

import { readFileSync } from 'node:fs';
import { checkFileSize } from './checks/file-size.mjs';
import { checkProcessEnv } from './checks/process-env.mjs';
import { checkSilentCatch } from './checks/silent-catch.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const { tool_input } = JSON.parse(input);
  const filePath = tool_input?.file_path;
  if (!filePath) process.exit(0);

  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch { process.exit(0); }

  const warnings = [
    checkFileSize(filePath, content),
    checkProcessEnv(filePath, content),
    checkSilentCatch(filePath, content),
  ].filter(Boolean);

  if (warnings.length > 0) {
    console.error('\n⚠️  CODE STANDARDS:');
    for (const w of warnings) console.error(`   ${w.message}`);
    console.error('');
  }
} catch {
  // Hook must never crash — silent exit
}

process.exit(0);
