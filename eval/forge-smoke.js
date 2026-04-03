// Forge infrastructure smoke test.
// Run: node eval/forge-smoke.js
// Exit 0 = all pass, exit 1 = any fail.

import { loadSkills, getActiveSkills, runSkillPostProcessors, describeCapabilities } from '../src/skill-registry.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;

function ok(label) {
  console.log(`[PASS] ${label}`);
  pass++;
}

function bad(label, err) {
  console.log(`[FAIL] ${label}${err ? ': ' + err : ''}`);
  fail++;
}

console.log('\n=== FORGE SMOKE TEST ===\n');

// 1. Registry loads
try {
  await loadSkills();
  const active = getActiveSkills();
  if (!Array.isArray(active) || active.length < 1) {
    bad('Registry loaded', `expected >= 1 skill, got ${active?.length}`);
  } else {
    ok(`Registry loaded: ${active.length} skill(s)`);
  }
} catch (err) {
  bad('Registry loaded', err.message);
}

// 2. Contract validation — every skill must have required fields
const active = getActiveSkills();
for (const skill of active) {
  const missing = [];
  if (!skill.name) missing.push('name');
  if (!skill.description) missing.push('description');
  if (typeof skill.canHandle !== 'function') missing.push('canHandle');
  if (typeof skill.execute !== 'function') missing.push('execute');
  if (!skill.selfExplanation) missing.push('selfExplanation');

  if (missing.length > 0) {
    bad(`${skill.name || 'unnamed'}: contract valid`, `missing: ${missing.join(', ')}`);
  } else {
    ok(`${skill.name}: contract valid`);
  }
}

// 3. Post-processing passthrough — no skills match, original preserved
try {
  const original = 'Test response';
  const result = await runSkillPostProcessors(
    original,
    { text: 'hello', category: 'conversational' },
    { responseLength: 13, isGroup: false }
  );
  if (result === original) {
    ok('No matching skills: original response preserved');
  } else {
    bad('No matching skills: original response preserved', `got "${result}"`);
  }
} catch (err) {
  bad('Post-processing passthrough', err.message);
}

// 4. describeCapabilities returns non-empty string
try {
  const desc = describeCapabilities();
  if (typeof desc === 'string' && desc.length > 0) {
    ok(`describeCapabilities: "${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''}"`);
  } else {
    bad('describeCapabilities', `expected non-empty string, got ${typeof desc}`);
  }
} catch (err) {
  bad('describeCapabilities', err.message);
}

// 5. Forge data directories exist
const forgeDirs = ['data/forge/specs', 'data/forge/reports', 'data/forge/meta', 'data/forge/prompts'];
for (const dir of forgeDirs) {
  const full = join(ROOT, dir);
  if (existsSync(full)) {
    ok(`${dir} exists`);
  } else {
    bad(`${dir} exists`, 'directory not found');
  }
}

// 6. Forge prompts exist
const prompts = ['analyst.md', 'architect.md', 'reviewer.md', 'tester.md', 'skill-contract.md'];
for (const file of prompts) {
  const full = join(ROOT, 'data/forge/prompts', file);
  if (existsSync(full)) {
    ok(`data/forge/prompts/${file} exists`);
  } else {
    bad(`data/forge/prompts/${file} exists`, 'file not found');
  }
}

// Summary
console.log(`\n=== RESULTS: ${pass} pass, ${fail} fail ===\n`);
process.exit(fail > 0 ? 1 : 0);
