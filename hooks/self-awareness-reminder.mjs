// hooks/self-awareness-reminder.mjs
// PostToolUse hook on Bash — detects git commits and flags stale self-awareness.

import { execSync } from 'node:child_process';

const FILE_TO_KNOWLEDGE = {
  'src/router.js': 'message-flow.json',
  'src/message-handler.js': 'message-flow.json',
  'src/cortex.js': 'message-flow.json',
  'src/memory.js': 'memory.json',
  'src/claude.js': 'architecture.json',
  'src/evo-client.js': 'architecture.json',
  'src/evo-llm.js': 'architecture.json',
  'src/tasks/forge-orchestrator.js': 'evolution.json',
  'src/evolution-executor.js': 'evolution.json',
  'src/scheduler.js': 'scheduler.json',
  'src/prompt.js': 'identity.json',
  'src/tools/definitions.js': 'tools.json',
  'src/tools/handler.js': 'tools.json',
  'src/group-modes.js': 'groups.json',
  'src/trigger.js': 'groups.json',
  'src/skill-registry.js': 'evolution.json',
  'src/voice-handler.js': 'voice.json',
  'architecture.md': 'architecture.json',
  'CLAUDE.md': 'meta.json',
};

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const { tool_input } = JSON.parse(input);
  const cmd = tool_input?.command || '';

  if (!cmd.includes('git commit')) process.exit(0);

  // Get files from last commit
  let files;
  try {
    files = execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf8' }).trim().split('\n');
  } catch {
    process.exit(0);
  }

  const staleKnowledge = new Set();
  for (const file of files) {
    const match = FILE_TO_KNOWLEDGE[file];
    if (match) staleKnowledge.add(match);
  }

  if (staleKnowledge.size > 0) {
    console.error(`\n📝 SELF-AWARENESS: These system-knowledge files may need updating:`);
    for (const k of staleKnowledge) console.error(`   data/system-knowledge/${k}`);
    console.error('');
  }
} catch {
  // Never crash
}

process.exit(0);
