// hooks/scope-guard.mjs
// PreToolUse hook — cross-platform port of evo-hooks/scope-guard.sh
// Only enforces scope during Forge/evolution runs (EVO_TASK_ID set).
// Normal development: always allows (exit 0).

import { readFileSync, existsSync } from 'node:fs';

// Skip entirely if not in a Forge/evolution context
if (!process.env.EVO_TASK_ID) process.exit(0);

const SCOPE_FILE = '/tmp/evo-task-scope.json';

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const { tool_name, tool_input } = JSON.parse(input);

  if (!existsSync(SCOPE_FILE)) {
    console.error('BLOCKED: No scope file found. Cannot proceed in evolution context.');
    process.exit(2);
  }

  const scope = JSON.parse(readFileSync(SCOPE_FILE, 'utf8'));

  // File edit tools — check file_path against allowed list
  if (['Edit', 'Write', 'MultiEdit'].includes(tool_name)) {
    const filePath = tool_input?.file_path || '';
    const relative = filePath.replace(/.*clawdbot[-/]?(claude-code)?[/\\]?/, '');

    if (!scope.allowed_files?.includes(relative)) {
      console.error(`BLOCKED: ${relative} is not in task scope. Allowed: ${scope.allowed_files?.join(', ')}`);
      process.exit(2);
    }
  }

  // Bash — check for writes to banned files
  if (tool_name === 'Bash') {
    const cmd = tool_input?.command || '';
    const BANNED = ['CLAUDE.md', 'EVOLUTION.md', '.env', 'package.json', 'package-lock.json'];
    const DANGEROUS = /sed -i|> |>> |tee |mv |cp |rm /;

    if (DANGEROUS.test(cmd)) {
      for (const banned of BANNED) {
        if (cmd.includes(banned)) {
          console.error(`BLOCKED: Bash targets banned file: ${banned}`);
          process.exit(2);
        }
      }
      if (/data\/|auth_state\/|node_modules\/|\.claude\//.test(cmd)) {
        console.error('BLOCKED: Bash targets protected directory.');
        process.exit(2);
      }
    }
  }
} catch {
  // Parse error — block in evolution context for safety
  console.error('BLOCKED: Hook parse error in evolution context.');
  process.exit(2);
}

process.exit(0);
