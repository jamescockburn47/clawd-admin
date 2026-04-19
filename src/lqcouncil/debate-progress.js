// src/lqcouncil/debate-progress.js — builds per-round and final-synthesis
// announcement text for an LQ Bot Council debate. Pure formatting: no
// WhatsApp send, no state, no persistence. The monitor task calls these
// on round-transition and complete-transition ticks and posts the result
// to the LQcouncil-bound group.

import * as lqc from './client.js';
import logger from '../logger.js';

const ROUND_LABELS = [
  'Blind formation',
  'Anonymous distribution',
  'Structured rebuttal',
  'Cross-examination',
  'Final position',
];

/**
 * Map a debate status string to the index of the last round that has
 * completed. Examples:
 *   created, round_0    → null  (round 0 is in progress; nothing done)
 *   round_1             → 0
 *   round_4             → 3
 *   analysing, synthesising, complete → 4
 *   failed, cancelled   → null  (caller shouldn't announce for these)
 */
export function lastCompletedRound(status) {
  if (typeof status !== 'string') return null;
  const roundMatch = /^round_(\d+)$/.exec(status);
  if (roundMatch) {
    const n = Number(roundMatch[1]);
    return n === 0 ? null : n - 1;
  }
  if (status === 'analysing' || status === 'synthesising' || status === 'complete') return 4;
  return null;
}

function truncate(s, max) {
  const str = String(s || '').trim();
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

/** Lift the first sentence out of a bot's response for the per-round line. */
function firstSentence(text, max = 180) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '(no response)';
  const firstEnd = cleaned.search(/[.!?](\s|$)/);
  const sentence = firstEnd === -1 ? cleaned : cleaned.slice(0, firstEnd + 1);
  return truncate(sentence, max);
}

function resolvePoint(entry) {
  // Synthesis items are sometimes `{point, evidence}`, sometimes raw
  // strings, depending on bot-council release. Be permissive.
  if (!entry) return '';
  if (typeof entry === 'string') return entry;
  if (typeof entry.point === 'string') return entry.point;
  if (typeof entry.claim === 'string') return entry.claim;
  if (typeof entry.summary === 'string') return entry.summary;
  return '';
}

/**
 * Build a WhatsApp-formatted summary of a round that has just completed.
 * Fetches the debate detail (for pseudonym → bot-name mapping) and the
 * transcript (for responses). Returns null on any fetch failure — the
 * caller should log and move on rather than re-try next tick.
 */
export async function buildRoundSummary(debateId, roundNumber) {
  let detail;
  let transcript;
  try {
    [detail, transcript] = await Promise.all([
      lqc.getDebate(debateId),
      lqc.getTranscript(debateId),
    ]);
  } catch (err) {
    logger.warn({ err: err.message, debateId, roundNumber }, 'debate-progress: fetch failed for round summary');
    return null;
  }

  const round = (transcript?.rounds || []).find((r) => r.round_number === roundNumber);
  if (!round) {
    logger.warn({ debateId, roundNumber }, 'debate-progress: round not found in transcript');
    return null;
  }

  const botMap = {};
  for (const b of detail?.bots || []) botMap[b.pseudonym] = b.bot_name || b.pseudonym;

  const label = ROUND_LABELS[roundNumber] || `Round ${roundNumber}`;
  const lines = [
    `*LQ Council — Round ${roundNumber} complete: ${label}*`,
    `Topic: ${truncate(detail?.topic || '', 180)}`,
    '',
  ];

  const responses = round.responses || [];
  if (responses.length === 0) {
    lines.push('  (no responses recorded)');
  } else {
    for (const r of responses) {
      const name = botMap[r.pseudonym] || r.pseudonym;
      const conf = r.confidence != null ? ` [conf ${r.confidence}]` : '';
      const status = r.abstained || !r.valid ? ' _[abstained]_' : '';
      const snippet = firstSentence(r.response);
      lines.push(`  • *${name}*${conf}${status}: ${snippet}`);
    }
  }

  lines.push('');
  lines.push(`Full transcript: \`lqc_debate_detail ${debateId}\``);
  return lines.join('\n');
}

/**
 * Build the final meta-commentary post for a debate that has transitioned
 * to `complete`. Pulls from /debates/{id}/synthesis. Returns null on fetch
 * failure or when synthesis is empty.
 */
export async function buildFinalCommentary(debateId) {
  let detail;
  let synthResp;
  try {
    [detail, synthResp] = await Promise.all([
      lqc.getDebate(debateId),
      lqc.getSynthesis(debateId),
    ]);
  } catch (err) {
    logger.warn({ err: err.message, debateId }, 'debate-progress: fetch failed for final commentary');
    return null;
  }

  const synthesis = synthResp?.synthesis || synthResp || {};
  const lines = [
    `*LQ Council — Debate complete*`,
    `Topic: ${truncate(detail?.topic || synthesis.topic || '', 200)}`,
    '',
  ];

  const consensus = (synthesis.consensus_points || []).slice(0, 3).map(resolvePoint).filter(Boolean);
  if (consensus.length > 0) {
    lines.push('*Consensus:*');
    for (const p of consensus) lines.push(`  • ${truncate(p, 240)}`);
    lines.push('');
  }

  const disagreements = (synthesis.live_disagreements || []).slice(0, 3).map(resolvePoint).filter(Boolean);
  if (disagreements.length > 0) {
    lines.push('*Live disagreements:*');
    for (const p of disagreements) lines.push(`  • ${truncate(p, 240)}`);
    lines.push('');
  }

  const minority = (synthesis.minority_positions || []).slice(0, 2).map(resolvePoint).filter(Boolean);
  if (minority.length > 0) {
    lines.push('*Minority positions:*');
    for (const p of minority) lines.push(`  • ${truncate(p, 240)}`);
    lines.push('');
  }

  const capitulations = (synthesis.flagged_capitulations || []).slice(0, 2).map(resolvePoint).filter(Boolean);
  if (capitulations.length > 0) {
    lines.push('*Capitulations flagged:*');
    for (const p of capitulations) lines.push(`  • ${truncate(p, 240)}`);
    lines.push('');
  }

  const meta = synthesis.meta_observations;
  if (meta) {
    const metaText = typeof meta === 'string' ? meta : resolvePoint(meta) || JSON.stringify(meta);
    if (metaText) {
      lines.push('*Meta:*');
      lines.push(truncate(metaText, 600));
      lines.push('');
    }
  }

  lines.push(`Full synthesis: \`lqc_debate_detail ${debateId}\``);
  return lines.join('\n');
}

/**
 * Build a long-form text block capturing the full context of a completed
 * debate for memory ingestion. Format is plain text with headings so the
 * memory service's extraction pipeline can treat it like a document and
 * so `memory_search` hits on topic keywords return recognisable excerpts.
 *
 * Structure:
 *   Topic
 *   Participants (bot_name = pseudonym, role)
 *   Round 0..4: each bot's response verbatim, confidence, challenge, position_change
 *   Synthesis: consensus, disagreements, minority, meta
 *
 * Returns null if required fetches fail.
 */
export async function buildDebateMemoryText(debateId) {
  let detail;
  let transcript;
  let synthResp = null;
  try {
    [detail, transcript] = await Promise.all([
      lqc.getDebate(debateId),
      lqc.getTranscript(debateId),
    ]);
  } catch (err) {
    logger.warn({ err: err.message, debateId }, 'debate-progress: memory-text fetch failed');
    return null;
  }
  try {
    synthResp = await lqc.getSynthesis(debateId);
  } catch {
    // synthesis may be missing on failed/cancelled — carry on with transcript only
  }

  const synthesis = synthResp?.synthesis || synthResp || {};
  const botMap = {};
  for (const b of detail?.bots || []) {
    botMap[b.pseudonym] = { name: b.bot_name || b.pseudonym, role: b.role || 'unassigned' };
  }

  const lines = [
    `LQ Council debate ${debateId}`,
    `Topic: ${detail?.topic || ''}`,
    `Status: ${detail?.status || 'unknown'}  |  created ${detail?.created_at || '?'}  |  completed ${detail?.completed_at || '?'}`,
    '',
    'Participants:',
  ];
  for (const [pseudonym, info] of Object.entries(botMap)) {
    lines.push(`  - ${info.name} (${pseudonym}, role: ${info.role})`);
  }
  lines.push('');

  for (const round of transcript?.rounds || []) {
    const n = round.round_number;
    lines.push(`### Round ${n}: ${ROUND_LABELS[n] || ''}`);
    for (const r of round.responses || []) {
      const info = botMap[r.pseudonym] || { name: r.pseudonym, role: '?' };
      const conf = r.confidence != null ? ` [confidence ${r.confidence}]` : '';
      const abs = r.abstained || !r.valid ? ' [ABSTAINED]' : '';
      lines.push(`${info.name} (${info.role})${conf}${abs}:`);
      lines.push(String(r.response || '(no response)').trim());
      if (r.challenge) {
        const c = r.challenge;
        lines.push(`  challenge: type=${c.type}; targets "${c.claim_targeted}"; counter: ${c.counter_evidence}`);
      }
      if (r.position_change) {
        const p = r.position_change;
        lines.push(`  position_change: changed=${p.changed}; from="${p.from_summary}"; to="${p.to_summary}"; reason=${p.reason}`);
      }
      lines.push('');
    }
  }

  const hasSynth =
    (synthesis.consensus_points || []).length > 0 ||
    (synthesis.live_disagreements || []).length > 0 ||
    (synthesis.minority_positions || []).length > 0 ||
    (synthesis.flagged_capitulations || []).length > 0 ||
    !!synthesis.meta_observations;

  if (hasSynth) {
    lines.push('### Synthesis');
    const pushPoints = (label, items) => {
      if (!Array.isArray(items) || items.length === 0) return;
      lines.push(`${label}:`);
      for (const item of items) {
        const point = resolvePoint(item);
        const evidence = item && typeof item === 'object' && item.evidence ? `  evidence: ${item.evidence}` : null;
        if (point) lines.push(`  - ${point}`);
        if (evidence) lines.push(evidence);
      }
      lines.push('');
    };
    pushPoints('Consensus', synthesis.consensus_points);
    pushPoints('Live disagreements', synthesis.live_disagreements);
    pushPoints('Minority positions', synthesis.minority_positions);
    pushPoints('Flagged capitulations', synthesis.flagged_capitulations);
    if (synthesis.meta_observations) {
      const meta =
        typeof synthesis.meta_observations === 'string'
          ? synthesis.meta_observations
          : JSON.stringify(synthesis.meta_observations, null, 2);
      lines.push('Meta observations:');
      lines.push(meta);
      lines.push('');
    }
  }

  return lines.join('\n');
}
