// Usage tracker — pricing calculation, daily call counting, usage stats persistence

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import config from './config.js';

// Pricing per million tokens — keyed by model prefix
const MODEL_PRICING = {
  'claude-sonnet-4': { input: 3.00, output: 15.00, cache_write: 3.75, cache_read: 0.30 },
  'claude-haiku-4': { input: 0.80, output: 4.00, cache_write: 1.00, cache_read: 0.08 },
  'claude-opus-4': { input: 15.00, output: 75.00, cache_write: 18.75, cache_read: 1.50 },
  'MiniMax': { input: 0.30, output: 1.20, cache_write: 0, cache_read: 0 },
};

// Default model for pricing lookups
const defaultModel = (config.minimaxApiKey) ? config.minimaxModel : config.claudeModel;

function getPricing(model) {
  const m = model || defaultModel;
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (m.startsWith(prefix)) return pricing;
  }
  return MODEL_PRICING['MiniMax'];
}

// Persistent usage file
const USAGE_FILE = join(config.authStatePath, 'usage.json');

function emptyBucket() {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, calls: 0 };
}

function loadUsage() {
  try {
    const data = JSON.parse(readFileSync(USAGE_FILE, 'utf-8'));
    if (!('cache_write' in data.today)) {
      data.today.cache_write = 0;
      data.today.cache_read = 0;
      data.total.cache_write = 0;
      data.total.cache_read = 0;
    }
    return data;
  } catch (_) {
    return {
      today: { ...emptyBucket(), date: new Date().toDateString() },
      total: { ...emptyBucket(), since: new Date().toISOString() },
    };
  }
}

const usage = loadUsage();
let dailyCalls = 0;
let dailyResetDate = new Date().toDateString();

let saveTimer = null;

function saveUsage() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) { /* intentional: best-effort periodic usage save */ }
    saveTimer = null;
  }, 10000);
}

export function flushUsage() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try { writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) { /* intentional: best-effort usage flush */ }
}

export function trackTokens(response) {
  const u = response.usage || {};
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;

  const today = new Date().toDateString();
  if (today !== usage.today.date) {
    usage.today = { ...emptyBucket(), date: today };
  }

  usage.today.input += inp;
  usage.today.output += out;
  usage.today.cache_write += cw;
  usage.today.cache_read += cr;
  usage.total.input += inp;
  usage.total.output += out;
  usage.total.cache_write += cw;
  usage.total.cache_read += cr;
  saveUsage();
}

function calcCost(bucket) {
  const p = getPricing();
  return (bucket.input / 1_000_000) * p.input
    + (bucket.output / 1_000_000) * p.output
    + ((bucket.cache_write || 0) / 1_000_000) * p.cache_write
    + ((bucket.cache_read || 0) / 1_000_000) * p.cache_read;
}

export function getUsageStats() {
  const today = new Date().toDateString();
  if (today !== usage.today.date) {
    usage.today = { ...emptyBucket(), date: today };
  }
  return {
    today: { ...usage.today, cost: calcCost(usage.today) },
    total: { ...usage.total, cost: calcCost(usage.total) },
    model: config.claudeModel,
    dailyLimit: config.dailyCallLimit,
    pricing: getPricing(),
  };
}

export function checkDailyLimit() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyCalls = 0;
    dailyResetDate = today;
  }
  return dailyCalls < config.dailyCallLimit;
}

export function incrementDailyCalls() {
  dailyCalls++;
  return dailyCalls;
}

export function getDailyCalls() {
  return dailyCalls;
}

export function recordCallInUsage() {
  usage.today.calls = dailyCalls;
  usage.total.calls++;
}
