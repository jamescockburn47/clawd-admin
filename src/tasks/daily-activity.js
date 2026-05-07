// Task: Daily activity summary DM (07:30 London).
//
// Companion to the morning briefing (07:00). The briefing is forward-looking
// — weather, today's calendar, novel dreams, what's on. This task is
// backward-looking — a plain-English narrative of what Clint actually did
// yesterday: who messaged, what tools were called, which projects came up.
//
// Reads: data/conversation-logs/<yesterday>_*.jsonl, data/audit.json (filtered
// to yesterday), data/interactions.jsonl (filtered to yesterday). Stitches
// counts + a few representative excerpts and asks MiniMax for ~250 words.
//
// Costs: one MiniMax call per day (~3K input, ~400 output) — about £0.001.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../logger.js';

const STATE_FILE = join('data', 'daily-activity-state.json');

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); }
  catch (err) { logger.warn({ err: err.message }, 'failed to save daily-activity state'); }
}

const persisted = loadState();
let lastSummaryDate = persisted.lastSummaryDate || null;

function yesterdayString(todayStr) {
  const d = new Date(`${todayStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function readJsonlSafe(path, predicate) {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (!predicate || predicate(obj)) out.push(obj);
      } catch { /* skip malformed line */ }
    }
    return out;
  } catch (err) {
    logger.warn({ err: err.message, path }, 'failed to read jsonl');
    return [];
  }
}

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) {
    logger.warn({ err: err.message, path }, 'failed to read json');
    return null;
  }
}

function isOnDate(ts, dateStr) {
  if (!ts) return false;
  return String(ts).startsWith(dateStr);
}

function gatherActivity(yesterday) {
  // 1. Conversation logs: every file with prefix <yesterday>_
  const logsDir = join('data', 'conversation-logs');
  let messages = [];
  try {
    const files = existsSync(logsDir) ? readdirSync(logsDir) : [];
    for (const f of files) {
      if (!f.startsWith(`${yesterday}_`) || !f.endsWith('.jsonl')) continue;
      messages.push(...readJsonlSafe(join(logsDir, f)));
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to scan conversation-logs');
  }

  // 2. Audit (tool calls)
  const audit = readJsonSafe(join('data', 'audit.json')) || [];
  const yesterdayTools = audit.filter((e) => isOnDate(e.timestamp, yesterday));

  // 3. Interactions (one entry per inbound message; carries routing + tools)
  const interactions = readJsonlSafe(
    join('data', 'interactions.jsonl'),
    (e) => isOnDate(e.ts, yesterday),
  );

  return { messages, tools: yesterdayTools, interactions };
}

function buildContext({ messages, tools, interactions }) {
  // Counts
  const totalMessages = messages.length;
  const inboundFromHumans = messages.filter((m) => !m.isBot).length;
  const outbound = messages.filter((m) => m.isBot).length;

  // Tools by type
  const toolCounts = {};
  for (const t of tools) toolCounts[t.tool] = (toolCounts[t.tool] || 0) + 1;
  const toolBreakdown = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, n]) => `${tool}: ${n}`)
    .join(', ');

  // Senders (groups + DM partners)
  const senderCounts = {};
  for (const m of messages) {
    if (!m.isBot && m.sender) {
      senderCounts[m.sender] = (senderCounts[m.sender] || 0) + 1;
    }
  }
  const topSenders = Object.entries(senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([s, n]) => `${s}: ${n}`)
    .join(', ');

  // Routing: MiniMax vs Qwen vs Claude
  const modelCounts = {};
  for (const i of interactions) {
    const model = i?.routing?.model || 'unknown';
    modelCounts[model] = (modelCounts[model] || 0) + 1;
  }
  const modelBreakdown = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}: ${n}`)
    .join(', ');

  // Sample turns: first ~25 inbound human messages, truncated
  const samples = messages
    .filter((m) => !m.isBot && m.text && m.text.length > 5)
    .slice(0, 25)
    .map((m) => `- [${m.sender || '?'}] ${String(m.text).slice(0, 280)}`)
    .join('\n');

  return {
    totals: { totalMessages, inboundFromHumans, outbound, totalTools: tools.length, totalInteractions: interactions.length },
    toolBreakdown,
    topSenders,
    modelBreakdown,
    samples,
  };
}

async function summarise(yesterday, ctx) {
  if (!config.minimaxApiKey) {
    return null; // Caller will fall back to deterministic stitched summary.
  }
  const client = new Anthropic({
    apiKey: config.minimaxApiKey,
    baseURL: config.minimaxBaseUrl,
  });

  const system = `You are Clint, summarising your own activity from the prior day for James (your owner). Plain English, ~250 words, three short paragraphs. No bullet points, no markdown headers, no emojis. Be honest and concrete: what people asked about, which tools you used most, anything that stood out (errors, novel topics, repeated themes). Do not invent. If a number is zero, say so. End with one sentence flagging anything James might want to look at.`;

  const user = `Summarise yesterday (${yesterday}). Raw stats:

Totals: ${ctx.totals.totalMessages} messages logged (${ctx.totals.inboundFromHumans} inbound, ${ctx.totals.outbound} outbound), ${ctx.totals.totalTools} tool calls, ${ctx.totals.totalInteractions} routed interactions.

Tool breakdown: ${ctx.toolBreakdown || 'none'}.

Top senders: ${ctx.topSenders || 'none'}.

Model routing: ${ctx.modelBreakdown || 'none'}.

Inbound message samples (truncated):
${ctx.samples || '(no samples)'}`;

  const resp = await client.messages.create({
    model: config.minimaxModel || 'MiniMax-M2.7',
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = (resp?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}

function deterministicSummary(yesterday, ctx) {
  const { totals, toolBreakdown, topSenders, modelBreakdown } = ctx;
  return [
    `*Yesterday (${yesterday}) — activity summary (deterministic fallback)*`,
    `Messages: ${totals.totalMessages} (${totals.inboundFromHumans} inbound, ${totals.outbound} outbound). Routed interactions: ${totals.totalInteractions}.`,
    `Top senders: ${topSenders || '-'}.`,
    `Tools used: ${toolBreakdown || '-'}. Total tool calls: ${totals.totalTools}.`,
    `Model split: ${modelBreakdown || '-'}.`,
    `_LLM summariser unavailable; this is the raw count fallback._`,
  ].join('\n\n');
}

/**
 * Send the daily activity summary DM at the configured time.
 * @param {Function} sendFn - WhatsApp send function (DMs the owner)
 * @param {string} todayStr - YYYY-MM-DD London date
 * @param {number} hours - London hour
 * @param {number} minutes - London minute
 */
export async function checkDailyActivitySummary(sendFn, todayStr, hours, minutes) {
  if (!sendFn || config.dailyActivityEnabled === false) return;
  if (lastSummaryDate === todayStr) return;

  const [targetH, targetM] = (config.dailyActivityTime || '07:30').split(':').map(Number);
  if (hours < targetH || (hours === targetH && minutes < targetM)) return;
  // Don't send if more than 2h past the target window (prevents catch-up after restarts)
  const minutesSinceTarget = (hours - targetH) * 60 + (minutes - targetM);
  if (minutesSinceTarget > 120) return;

  lastSummaryDate = todayStr;
  saveState({ lastSummaryDate });

  const yesterday = yesterdayString(todayStr);

  try {
    const activity = gatherActivity(yesterday);
    const ctx = buildContext(activity);

    let body;
    try {
      body = await summarise(yesterday, ctx);
    } catch (err) {
      logger.warn({ err: err.message }, 'daily-activity summarise call failed; using fallback');
      body = null;
    }
    if (!body) body = deterministicSummary(yesterday, ctx);

    const header = `*Yesterday in review.*\n`;
    await sendFn(header + body);
    logger.info({ yesterday, totals: ctx.totals }, 'daily activity summary sent');
  } catch (err) {
    logger.error({ err: err.message }, 'daily activity summary failed');
  }
}

export function getLastDailyActivityDate() { return lastSummaryDate; }
