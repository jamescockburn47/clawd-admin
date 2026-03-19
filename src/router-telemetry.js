// Router telemetry — logs routing decisions to data/router-stats.jsonl
import { appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from './logger.js';

const STATS_FILE = join('data', 'router-stats.jsonl');

// In-memory counters for quick status queries (reset daily)
let todayDate = new Date().toDateString();
const counters = { local: 0, claude: 0, fallback: 0, total: 0 };

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (today !== todayDate) {
    todayDate = today;
    counters.local = 0;
    counters.claude = 0;
    counters.fallback = 0;
    counters.total = 0;
  }
}

export function logRouting({ category, confidence, model, latencyMs, fallback, reason, toolsCalled, text }) {
  resetIfNewDay();

  counters.total++;
  if (fallback) counters.fallback++;
  else if (model === 'local') counters.local++;
  else counters.claude++;

  const entry = {
    ts: new Date().toISOString(),
    category,
    confidence: confidence ?? null,
    model,
    latencyMs: latencyMs ?? null,
    fallback: fallback || false,
    reason: reason || null,
    tools: toolsCalled || [],
    text: text ? text.slice(0, 200) : null,
  };

  try {
    appendFileSync(STATS_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    logger.warn({ err: err.message }, 'router telemetry write failed');
  }
}

export function getRoutingStats() {
  resetIfNewDay();
  return { ...counters, date: todayDate };
}
