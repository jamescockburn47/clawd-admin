// src/constants.js — Shared constants for the Clawdbot codebase
// All objects are frozen to prevent accidental mutation.

// Activity categories (canonical source — imported by router.js and claude.js)
export const CATEGORY = Object.freeze({
  CALENDAR: 'calendar',
  TASK: 'task',
  TRAVEL: 'travel',
  EMAIL: 'email',
  RECALL: 'recall',
  PLANNING: 'planning',
  CONVERSATIONAL: 'conversational',
  GENERAL_KNOWLEDGE: 'general_knowledge',
  SYSTEM: 'system',
});

// Timeout constants (milliseconds)
export const TIMEOUTS = Object.freeze({
  EVO_REQUEST: 60000,          // General EVO LLM request timeout
  EVO_CLASSIFIER: 5000,        // Classifier (small model, fast)
  EVO_HEALTH_CHECK: 3000,      // Health endpoint check
  MEMORY_HEALTH_CHECK: 5000,   // Memory service health check
  MEMORY_DEFAULT: 10000,       // Default memory service request
  MEMORY_STORE: 30000,         // Memory store operation
  MEMORY_EXTRACT: 120000,      // Conversation extraction
  MEMORY_SEARCH: 15000,        // Memory search
  MEMORY_NOTE: 60000,          // Note storage
  MEMORY_IMAGE: 120000,        // Image analysis
  MEMORY_AUDIO: 120000,        // Audio transcription
  DOCLING_PARSE: 30000,        // Granite-Docling page parse
  DOC_SUMMARISE: 30000,        // Document summarisation
  WEB_FETCH: 15000,            // Web page fetch
  WEB_SEARCH: 10000,           // SearXNG search
  SSH_DEFAULT: 30000,          // Default SSH command
  PLAN_PASS: 2 * 60 * 1000,   // Evolution plan pass
  EXECUTE_PASS: 5 * 60 * 1000, // Evolution execute pass
});

// Buffer and message limits
export const LIMITS = Object.freeze({
  MESSAGE_BUFFER_LENGTH: 10,   // Context message count default
  MAX_TOOL_RESULT: 1500,       // Max chars per tool result
  MAX_FETCH_CHARS: 8000,       // Max chars from web fetch
  MAX_TOOL_LOOPS: 5,           // Max tool call loops
  EVOLUTION_MAX_FILES: 5,      // Max files per evolution task
  EVOLUTION_MAX_LINES: 150,    // Max lines changed per evolution task
  PLAN_MAX_TURNS: 10,          // Claude Code turns for planning
  EXECUTE_MAX_TURNS: 20,       // Claude Code turns for execution
});

// Task planner constants
export const PLANNING = Object.freeze({
  MAX_STEPS: 8,                    // Maximum steps in a plan
  STEP_TIMEOUT_MS: 30_000,        // Per-step execution timeout
  TOTAL_TIMEOUT_MS: 120_000,      // Entire plan execution timeout
  MAX_REPLANS: 1,                  // Maximum suffix replans on failure
  PRUNE_INTERVAL_MS: 600_000,     // 10 min — prune completed plans
  PRUNE_AGE_MS: 7_200_000,        // 2 hours — plans older than this are pruned
  MIN_CONFIDENCE: 0.7,            // Below this, fall back to single-shot
  DECOMPOSE_TIMEOUT_MS: 15_000,   // Per decomposition pass timeout
  SYNTHESIS_TIMEOUT_MS: 10_000,   // Final response synthesis timeout
});

// Cooldown and duration constants (milliseconds)
export const COOLDOWNS = Object.freeze({
  GROUP_RESPONSE: 120000,      // 2 min cooldown after group response
  MUTE_DURATION: 600000,       // 10 min mute on "shut up"
  CIRCUIT_BREAKER_RESET: 60000, // Circuit breaker reset timeout
  CLASSIFIER_COOLDOWN: 30000,  // Classifier circuit breaker cooldown
  CACHE_SYNC_INTERVAL: 30,     // Minutes between cache syncs
  EVO_WARM_INTERVAL: 10,       // Minutes between keep-warm pings
});
