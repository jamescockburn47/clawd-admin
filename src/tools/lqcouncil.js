// src/tools/lqcouncil.js — tool handlers for the LQ Council integration.
//
// Implements the read-only Clint tools Phase 2 ships. Each handler
// returns a human-readable string so Clint's LLM can quote it directly,
// or formatted data for further reasoning. Gating to the dev group is
// enforced in group-tool-policy.js — these handlers assume they're
// being called from an authorised context.

import * as lqc from '../lqcouncil/client.js';
import * as sentry from '../lqcouncil/sentry-client.js';
import * as knowledge from '../lqcouncil/knowledge.js';
import {
  storeProposal,
  consumeProposal,
  PENDING_DEBATE_EXPIRY_MS,
} from '../lqcouncil/pending-debates.js';
import logger from '../logger.js';

// ── Helpers ──────────────────────────────────────────────────────────

function pct(x) {
  if (x === null || x === undefined) return 'n/a';
  return `${Math.round(x * 100)}%`;
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncate(s, n = 200) {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

// ── Status / overview ────────────────────────────────────────────────

export async function lqcStatus() {
  try {
    const [health, debates] = await Promise.all([
      lqc.getDiagHealth(),
      lqc.listDebates({ limit: 5 }),
    ]);
    const lines = [
      `*LQ Council status*`,
      `Release: ${health.release}`,
      `In flight: ${health.debates_in_flight}`,
      `Last completion: ${timeAgo(health.last_completion_ts)} (${health.last_completion_ts || 'never'})`,
      `Failure rate (1h): ${pct(health.failure_rate_1h)} over ${health.terminal_1h} terminal (${health.failures_1h} failed)`,
    ];
    if (debates && debates.length > 0) {
      lines.push('', '*Recent debates:*');
      for (const d of debates) {
        lines.push(`  - [${d.status}] ${truncate(d.topic, 80)} (${d.id.slice(0, 8)})`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `LQ Council status check failed: ${err.message}`;
  }
}

// ── Debate listing / detail ──────────────────────────────────────────

export async function lqcListDebates(input = {}) {
  try {
    const limit = Math.min(Math.max(parseInt(input.limit, 10) || 10, 1), 50);
    const status = input.status || null;
    const debates = await lqc.listDebates({ limit, status });
    if (!debates || debates.length === 0) return 'No debates match that query.';
    return debates.map((d) => {
      const completed = d.completed_at ? ` → ${d.completed_at}` : '';
      return `*${d.id.slice(0, 8)}* [${d.status}] ${d.topic}\n  ${d.bots.length} bots, created ${d.created_at}${completed}`;
    }).join('\n\n');
  } catch (err) {
    return `Failed to list debates: ${err.message}`;
  }
}

export async function lqcDebateDetail(input) {
  try {
    if (!input.debate_id) return 'debate_id is required.';
    const detail = await lqc.getDebate(input.debate_id);
    const lines = [
      `*Debate ${detail.id}*`,
      `Topic: ${detail.topic}`,
      `Status: ${detail.status}`,
      `Created: ${detail.created_at}${detail.completed_at ? ` → ${detail.completed_at}` : ''}`,
      `Bots (${detail.bots.length}):`,
      ...detail.bots.map((b) => `  - ${b.pseudonym} [${b.role || 'unassigned'}] = ${b.bot_name}`),
    ];
    if (detail.results) {
      lines.push('', '*Rankings (0-10 peer-scored):*');
      for (const r of detail.results.rankings) {
        lines.push(
          `  ${r.pseudonym}: overall ${r.avg_overall.toFixed(2)} (reasoning ${r.avg_reasoning_quality.toFixed(1)}, factual ${r.avg_factual_grounding.toFixed(1)}, ${r.total_scores} scores)`,
        );
      }
    }
    return lines.join('\n');
  } catch (err) {
    return `Failed to fetch debate detail: ${err.message}`;
  }
}

// ── Bots ─────────────────────────────────────────────────────────────

export async function lqcListBots(input = {}) {
  try {
    const bots = await lqc.listBots();
    const filter = input.status ? String(input.status).toLowerCase() : null;
    const filtered = filter ? bots.filter((b) => (b.status || '').toLowerCase() === filter) : bots;
    if (filtered.length === 0) return filter ? `No bots with status '${filter}'.` : 'No bots registered.';
    return filtered.map((b) =>
      `*${b.name}* [${b.status}] — ${b.id.slice(0, 8)}\n  ${b.endpoint_url}${b.model_family ? ` (${b.model_family})` : ''}${b.submitted_by ? `\n  Submitted by: ${b.submitted_by}` : ''}`,
    ).join('\n\n');
  } catch (err) {
    return `Failed to list bots: ${err.message}`;
  }
}

export async function lqcBotSchema() {
  try {
    const schema = await lqc.getBotSchema();
    const lines = [
      `*Bot wire schema* (${schema.dialect}, harness v${schema.version})`,
      '',
      '*DebateRoundRequest* (sent by the harness to your /debate endpoint):',
      describeSchema(schema.request),
      '',
      '*DebateRoundResponse* (your bot returns):',
      describeSchema(schema.response),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Failed to fetch bot schema: ${err.message}`;
  }
}

function describeSchema(node) {
  if (!node || typeof node !== 'object') return '(empty schema)';
  const props = node.properties || {};
  const required = new Set(node.required || []);
  const lines = [];
  for (const [name, field] of Object.entries(props)) {
    const isRequired = required.has(name) ? 'required' : 'optional';
    const type = Array.isArray(field.type) ? field.type.filter((t) => t !== 'null').join('|') : (field.type || 'object');
    const desc = field.description ? ` — ${field.description}` : '';
    lines.push(`  • ${name} (${type}, ${isRequired})${desc}`);
  }
  return lines.join('\n');
}

// ── Validation ───────────────────────────────────────────────────────

export async function lqcValidateBot(input) {
  try {
    if (!input.endpoint_url) return 'endpoint_url is required.';
    if (!input.token) return 'token is required (your bot\'s bearer token, not an LQC credential).';
    const result = await lqc.validateBot({ endpoint_url: input.endpoint_url, token: input.token });
    const head = result.ok ? '*Validation passed*' : '*Validation FAILED*';
    const lines = [head, ''];
    for (const c of result.checks) {
      lines.push(`${c.passed ? '[PASS]' : '[FAIL]'} ${c.name}: ${c.detail}`);
    }
    if (!result.ok) {
      lines.push('', 'Fix the failing check(s) and run `lqc_validate_bot` again before submitting for admin approval.');
    }
    return lines.join('\n');
  } catch (err) {
    return `Validation call failed: ${err.message}`;
  }
}

// ── Diagnosis ────────────────────────────────────────────────────────

const ERROR_KIND_HINTS = {
  timeout: 'Your /debate endpoint is exceeding the 300s round budget. Investigate internal LLM latency and consider parallelising or shortening prompts.',
  http_5xx: 'Your bot returned a 5xx. Check server logs for unhandled exceptions; add request-level error handling to return a graceful abstention body.',
  http_4xx: 'Harness call rejected as 4xx. Verify the bearer token matches the one you registered; check your route accepts POST.',
  connection_refused: 'Harness could not open a connection. If self-hosting, confirm the process is running and the port is publicly reachable (firewall / Cloudflare tunnel / ngrok).',
  dns: 'Hostname did not resolve. Double-check the endpoint URL and that the domain has an A/AAAA record.',
  tls: 'TLS handshake failed. Endpoint must be HTTPS with a valid (non-self-signed in prod) certificate.',
  json_parse: 'Your bot\'s response body is not valid JSON. Ensure Content-Type: application/json and a single JSON object (no wrapping text).',
  schema_missing_field: 'Your response JSON is missing a required field. `response` is required every round; `challenge` is required round 2; `position_change` is required round 4.',
  schema_invalid_type: 'A required field has the wrong type. `response` must be a string; `confidence` must be an integer 0-100.',
  schema_invalid_value: 'A field value is out of range or malformed. Typical culprit: confidence outside 0-100, or oversized response body (>512 KB).',
  internal: 'Unclassified failure. Share the raw detail with James and ask for a closer look.',
};

export async function lqcBotDiagnose(input) {
  try {
    if (!input.bot_id) return 'bot_id is required. Use lqc_list_bots to find it.';
    const limit = Math.min(Math.max(parseInt(input.limit, 10) || 20, 5), 100);
    const history = await lqc.getBotHistory(input.bot_id, { limit });
    if (!history || history.length === 0) {
      return `No debate history for bot ${input.bot_id}. Either the bot has never been called, or the bot_id is wrong.`;
    }
    const total = history.length;
    const failed = history.filter((r) => r.abstained || !r.valid).length;
    const byKind = new Map();
    for (const r of history) {
      if (!r.error_kind) continue;
      const entry = byKind.get(r.error_kind) || { count: 0, latest: null, details: new Set() };
      entry.count += 1;
      entry.latest = entry.latest || r.created_at;
      if (r.error_detail) entry.details.add(r.error_detail);
      byKind.set(r.error_kind, entry);
    }

    const lines = [
      `*Bot diagnosis — ${input.bot_id.slice(0, 12)}*`,
      `Recent rounds: ${total}  |  failed/abstained: ${failed}  |  failure rate: ${pct(failed / total)}`,
    ];

    if (byKind.size === 0) {
      lines.push(
        '',
        failed === 0
          ? 'No errors recorded in the last ' + total + ' rounds. Bot is healthy.'
          : 'Abstentions present but none are classified yet. Older rounds pre-date the error_kind taxonomy — ask the bot author for server logs.',
      );
      return lines.join('\n');
    }

    lines.push('', '*Failure breakdown (last ' + total + ' rounds):*');
    const sorted = Array.from(byKind.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [kind, entry] of sorted) {
      const details = Array.from(entry.details).slice(0, 3).join('; ');
      lines.push(`  • ${kind} ×${entry.count} (latest ${timeAgo(entry.latest)})${details ? ` — ${truncate(details, 200)}` : ''}`);
    }

    lines.push('', '*Suggested remediations:*');
    for (const [kind] of sorted.slice(0, 3)) {
      const hint = ERROR_KIND_HINTS[kind] || 'See /bots/schema for field contract.';
      lines.push(`  • ${kind}: ${hint}`);
    }

    return lines.join('\n');
  } catch (err) {
    return `Diagnosis failed: ${err.message}`;
  }
}

// ── Static guides ────────────────────────────────────────────────────

export async function lqcSelfDescribe() {
  return [
    '*Clint ↔ LQ Council tools (LQcouncil-bound groups / owner DM only):*',
    '',
    '  • `lqc_status` — harness health + recent debates',
    '  • `lqc_list_debates` — list debates (optional status filter)',
    '  • `lqc_debate_detail` — single-debate summary (topic, bots, rankings)',
    '  • `lqc_list_bots` — list registered bots (optional status filter)',
    '  • `lqc_bot_schema` — wire schema for /debate requests and responses',
    '  • `lqc_validate_bot` — dry-run smoke test against a candidate endpoint',
    '  • `lqc_dry_run_debate` — POST a real round-0 prompt to a candidate bot and show what it produces',
    '  • `lqc_bot_diagnose` — aggregate per-bot failure patterns and suggest fixes',
    '  • `lqc_bot_author_guide` — onboarding explainer (by topic)',
    '  • `lqc_onboarding_checklist` — step-by-step admission status',
    '  • `lqc_knowledge` — curated LQcouncil reference (topic ids: overview, onboarding, request-schema, response-schema, rounds, roles, confidence-and-scoring, endpoint-contract, test-before-submit, error-taxonomy, llm-wrapping, abstention, operational-facts)',
    '  • `lqc_self_describe` — this list',
    '',
    'All tools are read-only. Write actions (approve/reject/deactivate bots, create debates) are not exposed yet.',
  ].join('\n');
}

/**
 * POST a real round-0 debate prompt to a candidate bot's /debate endpoint
 * and return the structured result. Shape matches the prod orchestrator's
 * round-0 call so the bot author sees exactly what their bot would produce
 * in a real debate — catches bugs the generic /bots/validate smoke test
 * does not (prompt interpretation, latency under realistic load, JSON
 * field typos that only surface on non-trivial input).
 *
 * Returns structured data Clint's LLM can format into a WA reply:
 * { ok, elapsed_ms, status, raw_response, schema_ok, schema_errors[], body_size }
 */
export async function lqcDryRunDebate({ endpoint_url, token, topic, role = 'proponent' } = {}) {
  if (!endpoint_url || typeof endpoint_url !== 'string') {
    return 'dry-run failed: `endpoint_url` is required.';
  }
  if (!token || typeof token !== 'string') {
    return 'dry-run failed: `token` is required.';
  }
  if (!topic || typeof topic !== 'string') {
    return 'dry-run failed: `topic` is required (the debate proposition).';
  }

  const sessionId = `clint-dry-run-${Date.now()}`;
  const body = {
    session_id: sessionId,
    round: 0,
    role,
    context: [],
    prompt: [
      'You are participating in a structured adversarial debate.',
      `Topic: ${topic}`,
      `Your role: ${role}`,
      '',
      'State your initial position on this topic. Be substantive and specific.',
      'Do not hedge or equivocate — commit to a clear position consistent with your assigned role.',
    ].join('\n'),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const start = Date.now();
  let resp = null;
  let err = null;
  try {
    resp = await fetch(endpoint_url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    err = e.message || String(e);
  } finally {
    clearTimeout(timer);
  }
  const elapsed_ms = Date.now() - start;

  if (err) {
    return [
      '*Dry-run failed before response*',
      `endpoint: ${endpoint_url}`,
      `elapsed: ${elapsed_ms}ms`,
      `error: ${err}`,
      '',
      'This usually means DNS, TLS, or connection refused — fix at the network layer before retrying.',
    ].join('\n');
  }

  const status = resp.status;
  const text = await resp.text();
  const bodySize = text.length;

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parseError = e.message || String(e);
  }

  const schemaErrors = [];
  let schemaOk = false;
  if (parsed !== null) {
    if (typeof parsed.response !== 'string') {
      schemaErrors.push(`missing or non-string \`response\` field (got ${typeof parsed.response})`);
    }
    if (bodySize > 512 * 1024) {
      schemaErrors.push(`body too large: ${bodySize} bytes (limit 524288)`);
    }
    // confidence is optional at round 0; only warn if present but wrong.
    if ('confidence' in parsed && parsed.confidence !== null && parsed.confidence !== undefined) {
      if (!Number.isInteger(parsed.confidence)) {
        schemaErrors.push(`confidence must be an integer (got ${typeof parsed.confidence} ${parsed.confidence}) — round 0 can omit it`);
      } else if (parsed.confidence < 0 || parsed.confidence > 100) {
        schemaErrors.push(`confidence out of range 0-100 (got ${parsed.confidence})`);
      }
    }
    schemaOk = schemaErrors.length === 0;
  }

  const lines = [
    `*Dry-run ${resp.ok && schemaOk ? 'PASS' : 'FAIL'}* — \`${endpoint_url}\``,
    `status: HTTP ${status}  |  elapsed: ${elapsed_ms}ms  |  body: ${bodySize} bytes`,
    `role: ${role}  |  session: ${sessionId}`,
    '',
  ];
  if (!resp.ok) {
    lines.push(`Non-2xx response. Body (truncated 400):`);
    lines.push('```');
    lines.push(text.slice(0, 400));
    lines.push('```');
  } else if (parseError) {
    lines.push(`Response was not valid JSON: ${parseError}`);
    lines.push('```');
    lines.push(text.slice(0, 400));
    lines.push('```');
  } else if (!schemaOk) {
    lines.push('Schema errors:');
    for (const e of schemaErrors) lines.push(`  - ${e}`);
    lines.push('');
    lines.push('Raw response (truncated 400):');
    lines.push('```');
    lines.push(text.slice(0, 400));
    lines.push('```');
  } else {
    lines.push(`response field: "${String(parsed.response).slice(0, 200)}${parsed.response.length > 200 ? '…' : ''}"`);
    if ('confidence' in parsed && parsed.confidence !== null) {
      lines.push(`confidence: ${parsed.confidence}`);
    }
    lines.push('');
    lines.push('Next step: test rounds 1-4 by submitting and participating in a real debate, or call `lqc_validate_bot` for the canonical smoke test shape.');
  }
  return lines.join('\n');
}

/**
 * Return curated LQcouncil knowledge. Two modes:
 *   - `topic_id`: return one specific chunk verbatim.
 *   - `query`: find the top matching chunks within a 1500-token budget.
 * Source: data/lqcouncil-knowledge.json, curated and regenerated from the
 * bot-council repo (not live state — for live state use the other lqc_* tools).
 */
export async function lqcKnowledge({ topic_id = null, query = null } = {}) {
  if (topic_id) {
    const chunk = knowledge.getChunkById(topic_id);
    if (!chunk) {
      const all = knowledge.getAllChunks().map((c) => c.id);
      return `No topic with id \`${topic_id}\`. Available: ${all.join(', ')}.`;
    }
    return `*${chunk.title}* (topic: \`${chunk.id}\`)\n\n${chunk.content}`;
  }
  if (query) {
    const hits = knowledge.findRelevantChunks(query);
    if (hits.length === 0) {
      const all = knowledge.getAllChunks().map((c) => c.id);
      return `No knowledge topics matched \`${query}\`. Available topics: ${all.join(', ')}. Try \`lqc_knowledge\` with an explicit \`topic_id\`.`;
    }
    return hits
      .map((h) => `*${h.title}* (topic: \`${h.id}\`, keywords matched: ${h.matchedKeywords.join(', ')})\n\n${h.content}`)
      .join('\n\n---\n\n');
  }
  const all = knowledge.getAllChunks();
  const lines = ['*LQcouncil knowledge topics (curated reference):*', ''];
  for (const c of all) {
    lines.push(`  • \`${c.id}\` — ${c.title}`);
  }
  lines.push('');
  lines.push('Call `lqc_knowledge` again with `topic_id` (exact id) or `query` (natural-language phrase).');
  return lines.join('\n');
}

const GUIDE_TOPICS = {
  overview: `**Getting a bot admitted** — end-to-end flow:

1. Write a /debate HTTP endpoint that accepts POST with JSON body matching DebateRoundRequest.
2. Return JSON matching DebateRoundResponse.
3. Host on HTTPS (prod) or http://localhost (dev) with a bearer token you keep secret.
4. Run \`lqc_validate_bot\` in this chat — iterates until all checks pass.
5. Submit via the LQC web UI (lqcouncil.com) — the harness stores your endpoint + encrypts the token.
6. Admin runs the approval smoke test. If it passes, status → \`active\` and your bot joins debates.
7. Monitor with \`lqc_bot_diagnose\` — if failures accumulate, the tool tells you which error_kind dominates and how to fix it.`,

  schema: `**Wire schema** — see \`lqc_bot_schema\` for the full derivation. Key points:

• Request: \`session_id\`, \`round\` (0–4), \`role\`, \`context\` (prior round responses, anonymised), \`prompt\`.
• Response MUST include \`response\` (string).
• \`confidence\` is 0–100 integer — used by peer-scoring, not 0.0–1.0. Your bot must know its own confidence.
• Round 2 MUST include \`challenge\`: {claim_targeted, counter_evidence, type}.
• Round 4 MUST include \`position_change\`: {changed, from_summary, to_summary, reason}.
• Other rounds: these fields are optional; omit them rather than filling with nulls.
• Oversized responses (>512 KB) are rejected — keep \`response\` focused.`,

  rounds: `**The 5 rounds** (see debate protocol spec for full detail):

• Round 0 — Blind Formation. You see only topic + your assigned role. Write your strongest argument.
• Round 1 — Anonymous Distribution. You see all round-0 responses (by pseudonym). React, extend, or defend.
• Round 2 — Structured Rebuttal. Pick one opponent's claim and challenge it with counter-evidence.
• Round 3 — Cross-Examination. Respond to challenges against your own claims, pose follow-ups.
• Round 4 — Final Position. Summarise where you landed and whether you changed position.

Your \`role\` (proponent / skeptic / devil's advocate / empiricist / steelman) is rotated across debates.`,

  failure_modes: `**Common failures and what to do about them** — see \`lqc_bot_diagnose <bot_id>\` for specific data:

• \`timeout\` — exceeded 300s per round. Check internal LLM latency. Cache where possible.
• \`http_5xx\` — your server threw. Add try/catch that returns a graceful abstention body.
• \`http_4xx\` — usually auth. Your /debate must accept \`Authorization: Bearer <token>\` where <token> is what you submitted.
• \`schema_missing_field\` — one of the required fields was absent. The detail names the field.
• \`schema_invalid_type\` — usually \`confidence\` as float instead of int, or \`response\` as non-string.
• \`schema_invalid_value\` — typical culprit: confidence outside 0–100, or a challenge object with the wrong shape.
• \`json_parse\` — your response isn't valid JSON. Check Content-Type is application/json and body is one object.

For any of these, \`lqc_validate_bot\` will reproduce the failure without needing a real debate.`,

  testing: `**How to test your bot before submitting:**

1. \`lqc_validate_bot endpoint_url=... token=...\` — runs the exact smoke test the admin will run.
2. Register your bot via the web UI while iterating — every debate the harness runs your bot in logs a row you can inspect via \`lqc_bot_diagnose\`.
3. Use \`lqc_bot_schema\` to compare your implementation to the derived JSON Schema. Any tool (e.g. AJV) can validate your responses against it.
4. Expect at least 3 debates of soak time before claiming stability — transient network issues happen.`,
};

export async function lqcBotAuthorGuide(input = {}) {
  const topic = String(input.topic || 'overview').toLowerCase();
  if (topic === 'all') {
    return Object.entries(GUIDE_TOPICS).map(([k, v]) => `${v}\n`).join('\n---\n\n');
  }
  const guide = GUIDE_TOPICS[topic];
  if (!guide) {
    return `Unknown topic "${topic}". Available: ${Object.keys(GUIDE_TOPICS).join(', ')}, or "all" for everything.`;
  }
  return guide;
}

// ── Start / confirm debate ───────────────────────────────────────────
// Two-step flow: `lqc_start_debate` builds a proposal and returns a
// confirm_id; `lqc_confirm_debate` fires POST /debates against that id.
// Debates are charged against the MiniMax quota (roughly 3-5 bots × 4
// rounds of tool-looping), so the confirm step is deliberate — one
// accidental tool call must not silently burn $0.05-0.15.

const DEFAULT_ROUND_COST_USD = 0.015; // rough — MiniMax M2.7 at 4 rounds, 5-8 tool calls
const MAX_DEBATE_TOPIC_CHARS = 300;

function estimateCost(botCount, rounds = 5) {
  return (botCount * rounds * DEFAULT_ROUND_COST_USD).toFixed(2);
}

/**
 * Propose a debate. Fetches currently-active bots from the harness,
 * generates a confirm_id, and returns the proposal as text for Clint
 * to relay to the user. The actual POST /debates call happens only
 * after `lqc_confirm_debate`.
 *
 * Inputs:
 *   - topic (required): the debate proposition. Trimmed, capped at 300 chars.
 *   - bot_ids (optional): explicit bot id list (bypasses auto-pick).
 *
 * Sender/chat attribution is captured separately by the audit log in
 * the main tool dispatcher; no need to thread it through here.
 */
export async function lqcStartDebate(input = {}) {
  const topicRaw = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (!topicRaw) return 'topic is required (the debate proposition as a sentence).';
  if (topicRaw.length > MAX_DEBATE_TOPIC_CHARS) {
    return `Topic too long (${topicRaw.length} chars; cap ${MAX_DEBATE_TOPIC_CHARS}). Shorten it and try again.`;
  }

  let botIds = Array.isArray(input.bot_ids) ? input.bot_ids.filter((b) => typeof b === 'string' && b.length > 0) : [];
  let selectedBots = [];

  try {
    const bots = await lqc.listBots();
    if (botIds.length > 0) {
      selectedBots = bots.filter((b) => botIds.includes(b.id));
      const missing = botIds.filter((id) => !selectedBots.some((b) => b.id === id));
      if (missing.length > 0) {
        return `Unknown bot id(s): ${missing.join(', ')}. Use lqc_list_bots to find valid ids.`;
      }
    } else {
      selectedBots = (bots || []).filter((b) => (b.status || '').toLowerCase() === 'active');
      botIds = selectedBots.map((b) => b.id);
    }
  } catch (err) {
    return `Could not fetch bot roster: ${err.message}`;
  }

  if (selectedBots.length < 2) {
    return `Need at least 2 active bots to start a debate; found ${selectedBots.length}. Activate more bots first.`;
  }

  const confirmId = storeProposal({
    topic: topicRaw,
    botIds,
    sourceJid: null,
    senderJid: null,
  });

  const expiryMinutes = Math.round(PENDING_DEBATE_EXPIRY_MS / 60000);
  const costEstimate = estimateCost(selectedBots.length);

  return [
    '*Debate proposal — confirm to start*',
    '',
    `Topic: ${topicRaw}`,
    `Bots (${selectedBots.length}): ${selectedBots.map((b) => b.name).join(', ')}`,
    `Estimated cost: ~$${costEstimate} (MiniMax, 4 rounds × ${selectedBots.length} bots)`,
    '',
    `Reply \`lqc_confirm_debate ${confirmId}\` to fire it.`,
    `Expires in ${expiryMinutes} min if no confirmation.`,
  ].join('\n');
}

/**
 * Confirm a pending debate proposal and actually POST /debates.
 * Single-use — a successful confirm consumes the entry so repeat calls
 * with the same id return an "expired/unknown" message rather than
 * firing a second debate.
 */
export async function lqcConfirmDebate(input = {}) {
  const confirmId = typeof input.confirm_id === 'string' ? input.confirm_id.trim() : '';
  if (!confirmId) return 'confirm_id is required. Use `lqc_start_debate` first to generate one.';

  const proposal = consumeProposal(confirmId);
  if (!proposal) {
    return `No pending debate with id \`${confirmId}\` (expired, already used, or never existed). Run \`lqc_start_debate\` again if you still want to fire it.`;
  }

  logger.info(
    { confirmId, topic: proposal.topic.slice(0, 80), botCount: proposal.botIds.length },
    'lqc_confirm_debate: firing',
  );

  try {
    const result = await lqc.createDebate({ topic: proposal.topic, bot_ids: proposal.botIds });
    const debateId = result?.id || result?.debate_id || 'unknown';
    return [
      '*Debate started*',
      `ID: ${debateId}`,
      `Topic: ${proposal.topic}`,
      `Bots: ${proposal.botIds.length}`,
      '',
      `Follow progress with \`lqc_debate_detail ${debateId}\` or wait for the completion alert.`,
    ].join('\n');
  } catch (err) {
    logger.warn({ err: err.message, confirmId }, 'lqc_confirm_debate: createDebate failed');
    return `Failed to start debate: ${err.message}`;
  }
}

// ── Correlation / Sentry ─────────────────────────────────────────────

export async function lqcWhyFailed(input) {
  try {
    if (!input.debate_id) return 'debate_id is required.';
    const [detail, transcript] = await Promise.all([
      lqc.getDebate(input.debate_id).catch((e) => ({ error: e.message })),
      lqc.getTranscript(input.debate_id).catch((e) => ({ error: e.message })),
    ]);
    if (detail.error) return `Could not fetch debate: ${detail.error}`;

    const lines = [
      `*Why debate ${input.debate_id} failed*`,
      `Topic: ${detail.topic}`,
      `Status: ${detail.status}`,
      `Started: ${detail.created_at}${detail.completed_at ? ` → ${detail.completed_at}` : ''}`,
    ];

    if (transcript && !transcript.error && Array.isArray(transcript.rounds)) {
      const abstentions = [];
      for (const round of transcript.rounds) {
        for (const entry of round.responses || []) {
          if (entry.abstained || !entry.valid) {
            abstentions.push({
              round: round.round_number,
              pseudonym: entry.pseudonym,
              reason: entry.validation_reasoning || '(no validation detail)',
            });
          }
        }
      }
      if (abstentions.length > 0) {
        lines.push('', '*Abstentions / invalid responses:*');
        for (const a of abstentions.slice(0, 10)) {
          lines.push(`  • Round ${a.round} — ${a.pseudonym}: ${truncate(a.reason, 160)}`);
        }
        if (abstentions.length > 10) lines.push(`  … plus ${abstentions.length - 10} more`);
      } else {
        lines.push('', 'No per-round abstentions recorded — failure may be from the analyser or synthesiser step.');
      }
    }

    if (sentry.isSentryConfigured()) {
      try {
        const issues = await sentry.searchIssues({
          query: `debate_id:${input.debate_id}`,
          limit: 5,
          age: '-24h',
        });
        lines.push('', '*Sentry issues tagged with this debate_id:*');
        lines.push(sentry.formatIssues(issues, { maxItems: 5 }));
      } catch (err) {
        lines.push('', `(Sentry lookup failed: ${err.message})`);
      }
    } else {
      lines.push('', '(Sentry not configured — set LQC_SENTRY_* env vars to correlate against upstream issues.)');
    }

    return lines.join('\n');
  } catch (err) {
    return `lqc_why_failed error: ${err.message}`;
  }
}

export async function lqcRecentErrors(input = {}) {
  if (!sentry.isSentryConfigured()) {
    return 'Sentry is not configured (set LQC_SENTRY_API_TOKEN, LQC_SENTRY_ORG, LQC_SENTRY_PROJECT_BACKEND). Use `lqc_bot_diagnose` for per-bot failure aggregation from the harness DB.';
  }
  const minutes = Math.min(Math.max(parseInt(input.since_minutes, 10) || 60, 5), 60 * 24);
  const age = `-${minutes}m`;
  const tagQuery = input.tag
    ? String(input.tag).trim()
    : '';
  try {
    const issues = await sentry.searchIssues({
      query: tagQuery,
      limit: 10,
      age,
    });
    const lines = [
      `*Recent Sentry issues (last ${minutes}m${tagQuery ? `, query "${tagQuery}"` : ''}):*`,
      '',
      sentry.formatIssues(issues, { maxItems: 10 }),
    ];
    return lines.join('\n');
  } catch (err) {
    return `lqc_recent_errors error: ${err.message}`;
  }
}

export async function lqcOnboardingChecklist(input = {}) {
  const botId = input.bot_id ? String(input.bot_id) : null;
  const steps = [
    { id: 'endpoint', label: 'Endpoint declared (HTTPS or http://localhost)', done: !!input.endpoint_url, suggest: 'Provide your /debate URL and bearer token.' },
    { id: 'validate', label: '`lqc_validate_bot` passed', done: false, suggest: 'Run `lqc_validate_bot` with your endpoint + token; fix any failing check.' },
    { id: 'submit', label: 'Submitted via the web UI', done: !!botId, suggest: 'Visit lqcouncil.com → Submit Bot. Record the bot_id you receive.' },
    { id: 'approve', label: 'Admin smoke test passed (status = active)', done: false, suggest: 'Ask James (or another admin) to approve. They will run the smoke test — if it fails, check `lqc_bot_diagnose` for specifics.' },
    { id: 'soak', label: 'Passed ≥3 real debates', done: false, suggest: 'Use `lqc_bot_diagnose` after a few debates. Aim for failure_rate < 10%.' },
  ];

  if (botId) {
    try {
      const bot = (await lqc.listBots()).find((b) => b.id === botId);
      if (bot) {
        if (bot.status === 'active' || bot.status === 'inactive') {
          steps[3].done = true;
        }
        const history = await lqc.getBotHistory(botId, { limit: 20 });
        if (history.length >= 3) {
          const failed = history.filter((r) => r.abstained || !r.valid).length;
          steps[4].done = failed / history.length < 0.1;
          steps[4].label += ` (observed: ${history.length} rounds, ${failed} failed = ${pct(failed / history.length)})`;
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'onboarding checklist: context fetch failed');
    }
  }

  const lines = ['*Bot admission checklist:*', ''];
  for (const s of steps) {
    lines.push(`  ${s.done ? '[x]' : '[ ]'} ${s.label}`);
    if (!s.done) lines.push(`      → ${s.suggest}`);
  }
  return lines.join('\n');
}
