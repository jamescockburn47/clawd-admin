// eval/router-eval.js — Comprehensive eval suite for the message router
// Run standalone: node eval/router-eval.js
// Import:         import { runFullEval, KEYWORD_LABELS, testPatternSafety } from './eval/router-eval.js'
//
// Tests keyword classification, complexity detection, write-intent detection,
// tool safety sets, and category config against labeled datasets.
// Returns structured accuracy scores used by the self-improvement gate.

// Must set before any imports (config.js hard-exits without this)
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'eval-placeholder';

// Dynamic import to ensure env is set first
const router = await import('../src/router.js');
const {
  classifyByKeywords, CATEGORY, getToolsForCategory, needsMemories, mustUseClaude,
  READ_SAFE_TOOLS, WRITE_DANGEROUS_TOOLS, detectComplexity, detectsWriteIntent,
  KEYWORD_RULES, CLAUDE_CATEGORIES, WRITE_LIKELY_CATEGORIES,
} = router;

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Load dynamically generated eval labels (from self-improvement cycle)
function loadLearnedEvalLabels() {
  const file = join('data', 'learned-eval-labels.json');
  try {
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return (data.labels || []).map(l => ({ msg: l.msg, expected: l.expected }));
  } catch { return []; }
}

// ============================================================================
// LABELED DATASETS
// ============================================================================

// Keyword classification: { msg, expected } where expected is category string or null
// null = no unambiguous keyword match (defers to LLM classifier)
export const KEYWORD_LABELS = [
  // --- Calendar (unambiguous matches) ---
  { msg: "what's on my calendar today", expected: 'calendar' },
  { msg: "what am i doing tomorrow", expected: 'calendar' },
  { msg: "check my diary", expected: 'calendar' },
  { msg: "free time on Thursday", expected: 'calendar' },
  { msg: "my week ahead", expected: 'calendar' },
  { msg: "my day looks busy", expected: 'calendar' },
  { msg: "upcoming events this month", expected: 'calendar' },
  { msg: "what have i got this week", expected: 'calendar' },
  { msg: "whats on this afternoon", expected: 'calendar' },
  { msg: "book an event for Friday", expected: 'calendar' },
  { msg: "schedule for Monday", expected: 'calendar' },

  // --- Task (unambiguous matches) ---
  { msg: "add to my todo list", expected: 'task' },
  { msg: "remind me to buy milk", expected: 'task' },
  { msg: "/todo get bread", expected: 'task' },
  { msg: "mark done the laundry", expected: 'task' },
  { msg: "my tasks for today", expected: 'task' },
  { msg: "add task call the dentist", expected: 'task' },
  { msg: "to do list please", expected: 'task' },
  { msg: "mark complete the report", expected: 'task' },
  { msg: "check my reminders", expected: 'task' },
  { msg: "to-do items", expected: 'task' },

  // --- Travel (unambiguous matches) ---
  { msg: "trains to York tomorrow", expected: 'travel' },
  { msg: "hotel near Kings Cross", expected: 'travel' },
  { msg: "find accommodation in Whitby", expected: 'travel' },
  { msg: "glamping pods near Helmsley", expected: 'travel' },
  { msg: "fares to Edinburgh", expected: 'travel' },
  { msg: "cottages in the moors", expected: 'travel' },
  { msg: "LNER services today", expected: 'travel' },
  { msg: "departures from London", expected: 'travel' },
  { msg: "airbnb in Robin Hoods Bay", expected: 'travel' },
  { msg: "booking a trip", expected: 'travel' },

  // --- Email (unambiguous matches) ---
  { msg: "check my email", expected: 'email' },
  { msg: "search my inbox", expected: 'email' },
  { msg: "forward that to John", expected: 'email' },
  { msg: "draft a quick note", expected: 'email' },
  { msg: "check gmail", expected: 'email' },
  { msg: "any new mail today", expected: 'email' },
  { msg: "change my personality to be funnier", expected: 'email' },
  { msg: "update my soul to be more witty", expected: 'email' },
  { msg: "send an email to MG", expected: 'email' },

  // --- System (unambiguous — no GK regex overlap) ---
  { msg: "system status", expected: 'system' },
  { msg: "tell me about yourself", expected: 'system' },
  { msg: "what services are running", expected: 'system' },
  { msg: "what changed recently", expected: 'system' },
  { msg: "what version are you on", expected: 'system' },
  { msg: "how are you running", expected: 'system' },
  { msg: "noise suppression settings", expected: 'system' },
  { msg: "whisper model info", expected: 'system' },
  { msg: "voice listener status", expected: 'system' },
  { msg: "ollama status", expected: 'system' },
  { msg: "evo x2 specs", expected: 'system' },
  { msg: "what's running right now", expected: 'system' },
  { msg: "what is deployed", expected: null },  // also matches GK "^what is" → ambiguous
  { msg: "status report please", expected: 'system' },

  // --- General knowledge (unambiguous — no system overlap) ---
  { msg: "what is quantum computing", expected: 'general_knowledge' },
  { msg: "who is the prime minister", expected: 'general_knowledge' },
  { msg: "where is Timbuktu", expected: 'general_knowledge' },
  { msg: "when did World War 2 end", expected: 'general_knowledge' },
  { msg: "how much does a Tesla cost", expected: 'general_knowledge' },
  { msg: "search the web for AI news", expected: 'general_knowledge' },
  { msg: "web search for recipe ideas", expected: 'general_knowledge' },
  { msg: "look this up for me", expected: 'general_knowledge' },
  { msg: "google best restaurants London", expected: 'general_knowledge' },

  // --- Conversational / null (no keyword match) ---
  { msg: "hello there", expected: null },
  { msg: "thanks mate", expected: null },
  { msg: "haha that's funny", expected: null },
  { msg: "good morning", expected: null },
  { msg: "how are you", expected: null },
  { msg: "I had a great weekend", expected: null },
  { msg: "nice one", expected: null },
  { msg: "see you later", expected: null },
  { msg: "ok cool", expected: null },
  { msg: "sounds good", expected: null },
  { msg: "cheers", expected: null },

  // --- Ambiguous (multiple categories match → null) ---
  { msg: "email me the train schedule", expected: null },       // email + travel
  { msg: "how does the voice pipeline work", expected: null },  // system + GK
  { msg: "what is evo x2", expected: null },                    // system + GK
  { msg: "how does the dashboard work", expected: null },       // system + GK
  { msg: "search for flights to York", expected: null },        // GK + travel
  { msg: "book a hotel for the calendar event", expected: null }, // travel + calendar
  { msg: "forward the travel booking email", expected: null },  // email + travel
];

// Complexity detection: { msg, expected }
export const COMPLEXITY_LABELS = [
  // Complex — multi-step conjunctions (≥2)
  { msg: "check my calendar and then book a train and also find a hotel", expected: true },
  { msg: "send the email then update the calendar then also remind me", expected: true },
  { msg: "find trains as well as hotels plus check my diary", expected: true },
  // Complex — long messages (>150 chars)
  { msg: "I need to plan a trip to York this weekend including finding the best train times from Kings Cross and booking accommodation near the North York Moors and checking my calendar for any potential conflicts with existing events", expected: true },
  // Complex — mixed question + imperative with conjunction
  { msg: "can you check my calendar and then schedule a meeting", expected: true },
  { msg: "what time is the train and then book me a ticket", expected: true },
  // Not complex — short, single intent
  { msg: "trains to York", expected: false },
  { msg: "check my email", expected: false },
  { msg: "what's on my calendar", expected: false },
  { msg: "hello", expected: false },
  { msg: "remind me to buy milk", expected: false },
  { msg: "how does the voice pipeline work", expected: false },
  // Edge cases — only 1 conjunction (not enough for multi-step)
  { msg: "check calendar then book train", expected: false },
  { msg: "find trains and hotels", expected: false },
  { msg: "what time is it", expected: false },
];

// Write intent detection: { msg, expected }
export const WRITE_INTENT_LABELS = [
  // Calendar writes
  { msg: "create an event for tomorrow at 3pm", expected: true },
  { msg: "book a meeting with John", expected: true },
  { msg: "schedule an appointment for Friday", expected: true },
  { msg: "cancel the meeting tomorrow", expected: true },
  { msg: "reschedule my event to next week", expected: true },
  { msg: "update the calendar entry", expected: true },
  { msg: "move my appointment to 4pm", expected: true },
  { msg: "change the meeting time", expected: true },
  // Email writes
  { msg: "send an email to MG", expected: true },
  { msg: "draft a message to the team", expected: true },
  { msg: "compose an email about the project", expected: true },
  { msg: "reply to that email from Sarah", expected: true },
  { msg: "forward the message to John", expected: true },
  { msg: "write a mail to the client", expected: true },
  // Not writes
  { msg: "what's on my calendar", expected: false },
  { msg: "check my email", expected: false },
  { msg: "trains to York", expected: false },
  { msg: "remind me to buy milk", expected: false },
  { msg: "hello", expected: false },
  { msg: "tell me about the system", expected: false },
  { msg: "search for hotels", expected: false },
  { msg: "what events do I have", expected: false },
  { msg: "show me my inbox", expected: false },
];

// Tool safety labels: { tool, safe, dangerous }
export const TOOL_SAFETY_LABELS = [
  // READ-SAFE tools (local model can handle)
  { tool: 'todo_list', safe: true, dangerous: false },
  { tool: 'calendar_list_events', safe: true, dangerous: false },
  { tool: 'calendar_find_free_time', safe: true, dangerous: false },
  { tool: 'memory_search', safe: true, dangerous: false },
  { tool: 'system_status', safe: true, dangerous: false },
  { tool: 'soul_read', safe: true, dangerous: false },
  // WRITE-DANGEROUS tools (must use Claude)
  { tool: 'gmail_draft', safe: false, dangerous: true },
  { tool: 'gmail_confirm_send', safe: false, dangerous: true },
  { tool: 'calendar_create_event', safe: false, dangerous: true },
  { tool: 'calendar_update_event', safe: false, dangerous: true },
  { tool: 'soul_propose', safe: false, dangerous: true },
  { tool: 'soul_confirm', safe: false, dangerous: true },
  { tool: 'memory_update', safe: false, dangerous: true },
  { tool: 'memory_delete', safe: false, dangerous: true },
  // Neutral tools (neither)
  { tool: 'todo_add', safe: false, dangerous: false },
  { tool: 'todo_complete', safe: false, dangerous: false },
  { tool: 'web_search', safe: false, dangerous: false },
  { tool: 'train_departures', safe: false, dangerous: false },
];

// ============================================================================
// EVAL FUNCTIONS
// ============================================================================

function runKeywordEval() {
  const results = { total: 0, correct: 0, failures: [] };
  const allLabels = [...KEYWORD_LABELS, ...loadLearnedEvalLabels()];
  for (const { msg, expected } of allLabels) {
    results.total++;
    const got = classifyByKeywords(msg);
    if (got === expected) {
      results.correct++;
    } else {
      results.failures.push({ msg, expected, got });
    }
  }
  results.accuracy = results.total > 0 ? results.correct / results.total : 1;
  return results;
}

function runComplexityEval() {
  const results = { total: 0, correct: 0, failures: [] };
  for (const { msg, expected } of COMPLEXITY_LABELS) {
    results.total++;
    const got = detectComplexity(msg);
    if (got.complex === expected) {
      results.correct++;
    } else {
      results.failures.push({ msg, expected, got: got.complex, reason: got.reason });
    }
  }
  results.accuracy = results.total > 0 ? results.correct / results.total : 1;
  return results;
}

function runWriteIntentEval() {
  const results = { total: 0, correct: 0, failures: [] };
  for (const { msg, expected } of WRITE_INTENT_LABELS) {
    results.total++;
    const got = detectsWriteIntent(msg);
    if (got === expected) {
      results.correct++;
    } else {
      results.failures.push({ msg, expected, got });
    }
  }
  results.accuracy = results.total > 0 ? results.correct / results.total : 1;
  return results;
}

function runToolSafetyEval() {
  const results = { total: 0, correct: 0, failures: [] };
  for (const { tool, safe, dangerous } of TOOL_SAFETY_LABELS) {
    results.total += 2;
    const isSafe = READ_SAFE_TOOLS.has(tool);
    const isDangerous = WRITE_DANGEROUS_TOOLS.has(tool);
    if (isSafe === safe) {
      results.correct++;
    } else {
      results.failures.push({ tool, check: 'READ_SAFE', expected: safe, got: isSafe });
    }
    if (isDangerous === dangerous) {
      results.correct++;
    } else {
      results.failures.push({ tool, check: 'WRITE_DANGEROUS', expected: dangerous, got: isDangerous });
    }
  }
  results.accuracy = results.total > 0 ? results.correct / results.total : 1;
  return results;
}

function runCategoryConfigEval() {
  const results = { total: 0, correct: 0, failures: [] };

  // Email and planning must always use Claude
  for (const cat of ['email', 'planning']) {
    results.total++;
    if (CLAUDE_CATEGORIES.has(cat)) {
      results.correct++;
    } else {
      results.failures.push({ check: 'must_use_claude', category: cat, got: false });
    }
  }

  // These should NOT force Claude
  for (const cat of ['system', 'calendar', 'task', 'travel', 'conversational', 'general_knowledge']) {
    results.total++;
    if (!CLAUDE_CATEGORIES.has(cat)) {
      results.correct++;
    } else {
      results.failures.push({ check: 'should_not_force_claude', category: cat, got: true });
    }
  }

  // Memory injection categories
  for (const cat of ['travel', 'recall', 'planning', 'system']) {
    results.total++;
    if (needsMemories(cat)) {
      results.correct++;
    } else {
      results.failures.push({ check: 'needs_memories', category: cat, got: false });
    }
  }

  // Non-memory categories
  for (const cat of ['calendar', 'task', 'email', 'conversational', 'general_knowledge']) {
    results.total++;
    if (!needsMemories(cat)) {
      results.correct++;
    } else {
      results.failures.push({ check: 'should_not_need_memories', category: cat, got: true });
    }
  }

  results.accuracy = results.total > 0 ? results.correct / results.total : 1;
  return results;
}

// Cross-contamination check: test if a proposed pattern matches messages from wrong categories
export function testPatternSafety(pattern, targetCategory) {
  try {
    const regex = new RegExp(pattern);
    const contamination = [];
    const allLabels = [...KEYWORD_LABELS, ...loadLearnedEvalLabels()];

    for (const { msg, expected } of allLabels) {
      if (expected === null || expected === targetCategory) continue;
      if (regex.test(msg.toLowerCase())) {
        contamination.push({ msg, category: expected });
      }
    }

    return { safe: contamination.length === 0, contamination };
  } catch (err) {
    return { safe: false, contamination: [], error: err.message };
  }
}

// ============================================================================
// MAIN EVAL RUNNER
// ============================================================================

export function runFullEval() {
  const keyword = runKeywordEval();
  const complexity = runComplexityEval();
  const writeIntent = runWriteIntentEval();
  const toolSafety = runToolSafetyEval();
  const categoryConfig = runCategoryConfigEval();

  const totalCorrect = keyword.correct + complexity.correct + writeIntent.correct
    + toolSafety.correct + categoryConfig.correct;
  const totalTests = keyword.total + complexity.total + writeIntent.total
    + toolSafety.total + categoryConfig.total;

  return {
    timestamp: new Date().toISOString(),
    keyword,
    complexity,
    writeIntent,
    toolSafety,
    categoryConfig,
    overall: totalTests > 0 ? totalCorrect / totalTests : 1,
    totalTests,
    totalCorrect,
  };
}

// ============================================================================
// STANDALONE RUNNER
// ============================================================================

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && process.argv[1].replace(/\\/g, '/') === __filename.replace(/\\/g, '/')) {
  const results = runFullEval();

  console.log('\n=== Clawd Router Eval ===\n');

  const sections = [
    ['Keyword classification', results.keyword],
    ['Complexity detection', results.complexity],
    ['Write-intent detection', results.writeIntent],
    ['Tool safety', results.toolSafety],
    ['Category config', results.categoryConfig],
  ];

  for (const [name, section] of sections) {
    const pct = (section.accuracy * 100).toFixed(1);
    const status = section.accuracy === 1 ? 'PASS' : 'FAIL';
    console.log(`${status}  ${name}: ${pct}% (${section.correct}/${section.total})`);
    for (const f of section.failures) {
      if (f.msg) {
        console.log(`      "${f.msg}" -> expected ${f.expected}, got ${f.got}${f.reason ? ` (${f.reason})` : ''}`);
      } else {
        console.log(`      ${JSON.stringify(f)}`);
      }
    }
  }

  console.log(`\nOverall: ${(results.overall * 100).toFixed(1)}% (${results.totalCorrect}/${results.totalTests})`);
  console.log(results.overall === 1 ? '\nAll evals passed.' : '\nSome evals failed.');
  process.exit(results.overall < 1.0 ? 1 : 0);
}
