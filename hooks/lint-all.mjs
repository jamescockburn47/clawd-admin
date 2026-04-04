// hooks/lint-all.mjs
// npm run lint:standards — full codebase standards audit

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { checkFileSize } from './checks/file-size.mjs';
import { checkProcessEnv } from './checks/process-env.mjs';
import { checkSilentCatch } from './checks/silent-catch.mjs';

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!['node_modules', '.git', 'auth_state', '.next'].includes(entry)) {
        results.push(...walk(full));
      }
    } else if (['.js', '.ts', '.mjs', '.py'].includes(extname(full))) {
      results.push(full);
    }
  }
  return results;
}

const files = walk('src');
const warnings = [];

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const checks = [
    checkFileSize(file, content),
    checkProcessEnv(file, content),
    checkSilentCatch(file, content),
  ].filter(Boolean);
  warnings.push(...checks);
}

if (warnings.length === 0) {
  console.log('All files pass standards checks.');
} else {
  console.log(`\n${warnings.length} violation(s):\n`);
  for (const w of warnings) console.log(`  ${w.message}`);
  console.log('');
  process.exit(1);
}
