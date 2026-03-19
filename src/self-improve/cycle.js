// src/self-improve/cycle.js — Autonomous self-improvement for router keyword rules
//
// Runs overnight: probe → propose → validate → apply → expand eval → repeat
// No hard rule cap — the eval gate is the real safety constraint.
// Multi-iteration: keeps running until no more improvements or time limit.
//
// Safety:
// - Cross-contamination check against full eval suite before applying
// - Post-iteration eval regression check with rollback
// - Subset dedup prevents redundant rules
// - All changes logged to data/self-improve-log.jsonl
// - WhatsApp notification summarising overnight progress

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import config from '../config.js';
import logger from '../logger.js';
import { reloadLearnedRules, KEYWORD_RULES, CATEGORY, classifyByKeywords } from '../router.js';

const TELEMETRY_FILE = join('data', 'router-stats.jsonl');
const LEARNED_RULES_FILE = join('data', 'learned-rules.json');
const LEARNED_EVAL_FILE = join('data', 'learned-eval-labels.json');
const CYCLE_LOG_FILE = join('data', 'self-improve-log.jsonl');

// --- Tuning knobs ---
const MAX_ITERATIONS = 5;          // probe-propose-apply loops per nightly run
const MAX_DURATION_MS = 30 * 60000; // 30 min hard time limit
const MAX_RULES_PER_ITERATION = 6;  // per iteration, not total
const MIN_MISSES_PER_CATEGORY = 2;
const MIN_SAMPLES_TO_ANALYZE = 10;
const GRADUATION_CYCLES = 3;       // survive N cycles → promoted to permanent

const EXCLUDED_CATEGORIES = new Set([
  'planning',       // fallback, shouldn't have keywords
  'conversational', // catch-all
  'recall',         // too context-dependent
]);

const PROBE_CATEGORIES = Object.values(CATEGORY).filter(c => !EXCLUDED_CATEGORIES.has(c));

// ============================================================================
// TELEMETRY
// ============================================================================

function readTelemetry(maxAgeDays = 7) {
  if (!existsSync(TELEMETRY_FILE)) return [];
  const cutoff = Date.now() - maxAgeDays * 86400000;
  const entries = [];
  try {
    const lines = readFileSync(TELEMETRY_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (new Date(entry.ts).getTime() >= cutoff && entry.text) entries.push(entry);
      } catch { /* skip */ }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'self-improve: failed to read telemetry');
  }
  return entries;
}

function findKeywordMisses(entries) {
  const misses = {};
  for (const entry of entries) {
    if (entry.reason === 'keywords') continue;
    if (!entry.text || !entry.category) continue;
    if (EXCLUDED_CATEGORIES.has(entry.category)) continue;
    if (entry.reason && entry.reason.includes('complex')) continue;
    if (!misses[entry.category]) misses[entry.category] = [];
    misses[entry.category].push(entry.text);
  }
  return misses;
}

// ============================================================================
// SYNTHETIC PROBES
// ============================================================================

function getCurrentPatternsForCategory(category) {
  // Collect patterns from hardcoded rules
  const rule = KEYWORD_RULES.find(r => r.category === category);
  if (!rule) return 'No existing patterns';
  const src = rule.test.toString();
  const regexMatches = [...src.matchAll(/\/(.+?)\//g)];
  let patterns = regexMatches.map(m => m[1]).join('\n');

  // Also include learned rules for this category
  const learned = loadLearnedRulesFile();
  const learnedForCat = learned.rules.filter(r => r.category === category);
  if (learnedForCat.length > 0) {
    patterns += '\n' + learnedForCat.map(r => r.pattern).join('\n');
  }
  return patterns;
}

async function generateProbeMessages(iteration = 0) {
  const evoLlmUrl = config.evoLlmUrl;
  const allMisses = {};

  for (const category of PROBE_CATEGORIES) {
    const currentPatterns = getCurrentPatternsForCategory(category);

    const prompt = `Generate 20 realistic WhatsApp messages that a user would send when they want to do something related to "${category}".

Context: This is a personal assistant bot for a UK-based professional. Messages are casual and short (typical WhatsApp style).

Category definitions:
- calendar: checking schedule, events, free time, booking meetings, clashes, availability
- task: todos, reminders, task lists, marking things done, priorities, deadlines
- travel: trains, hotels, flights, fares, accommodation, trips, routes, timetables
- email: reading/sending/drafting emails, inbox management, forwarding, replies
- system: asking about the bot itself, its status, architecture, components, what's running
- general_knowledge: factual questions, web lookups, explanations, current affairs

Generate DIVERSE messages. Vary sentence structure, length, formality.
Include casual abbreviations, questions, commands, and context-heavy requests.
Iteration ${iteration + 1} — try harder to find phrases NOT covered below.

Do NOT use these words/phrases (already handled):
${currentPatterns}

Reply with ONLY the messages, one per line, numbered 1-20. No explanations.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(`${evoLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: 'Generate realistic WhatsApp messages. Be natural and diverse. One per line.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7 + (iteration * 0.05), max_tokens: 600,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (!res.ok) continue;

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';

      const messages = content.split('\n')
        .map(line => line.replace(/^\d+[\.\)]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(m => m.length > 3 && m.length < 200);

      const misses = [];
      for (const msg of messages) {
        const result = classifyByKeywords(msg);
        if (result === null) misses.push(msg);
      }

      if (misses.length > 0) allMisses[category] = misses;
      logger.info({ category, generated: messages.length, misses: misses.length, iteration }, 'self-improve: probe complete');
    } catch (err) {
      clearTimeout(timeoutId);
      logger.warn({ category, err: err.message }, 'self-improve: probe failed');
    }
  }
  return allMisses;
}

// ============================================================================
// PROPOSAL GENERATION
// ============================================================================

async function generateProposals(category, missedMessages) {
  const evoLlmUrl = config.evoLlmUrl;
  const currentPatterns = getCurrentPatternsForCategory(category);

  const exclusionExamples = [];
  const catMsgs = {
    calendar: ['check my calendar', 'what am i doing tomorrow', 'my week ahead', 'free time on Thursday'],
    task: ['add to my todo list', 'remind me to buy milk', 'my tasks', 'mark done the laundry'],
    travel: ['trains to York', 'hotel near London', 'fares to Edinburgh', 'departures from Kings Cross'],
    email: ['check my email', 'draft a reply', 'search my inbox', 'forward that to John'],
    system: ['system status', 'what version', 'tell me about yourself', 'noise suppression settings'],
    general_knowledge: ['what is quantum computing', 'who is the PM', 'where is Timbuktu'],
  };
  for (const rule of KEYWORD_RULES) {
    if (rule.category === category) continue;
    for (const m of (catMsgs[rule.category] || [])) {
      exclusionExamples.push(`- "${m}" (${rule.category})`);
    }
  }

  const prompt = `You are analyzing message classification patterns for a WhatsApp bot router.

CATEGORY: ${category}

MESSAGES THAT SHOULD MATCH "${category}" (currently missed by keywords):
${missedMessages.slice(0, 15).map(m => `- "${m}"`).join('\n')}

CURRENT PATTERNS FOR ${category}:
${currentPatterns}

MESSAGES THAT MUST NOT MATCH (from other categories):
${exclusionExamples.join('\n')}

RULES:
1. Suggest 1-5 new regex patterns using \\b word boundaries
2. Each pattern: \\b(word1|word2|phrase)\\b
3. Patterns MUST match the missed messages
4. Patterns must NOT match exclusion messages
5. Prefer SPECIFIC terms over generic ones
6. Don't suggest single very common words (like "is", "the", "my", "check")

Format:
PATTERN: \\b(pattern here)\\b
MATCHES: msg1, msg2
REASON: why this is safe

If no safe pattern exists: NONE`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch(`${evoLlmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are a regex pattern expert. Be precise and conservative.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1, max_tokens: 600,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!res.ok) return [];

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    if (content.includes('NONE')) return [];

    const proposals = [];
    const patterns = [...content.matchAll(/PATTERN:\s*(.+)/gi)].map(m => m[1].trim());
    const matches = [...content.matchAll(/MATCHES:\s*(.+)/gi)].map(m => m[1].trim());
    const reasons = [...content.matchAll(/REASON:\s*(.+)/gi)].map(m => m[1].trim());

    for (let i = 0; i < patterns.length; i++) {
      try {
        new RegExp(patterns[i]);
        proposals.push({ pattern: patterns[i], matches: matches[i] || '', reason: reasons[i] || '', category });
      } catch { /* invalid regex */ }
    }
    return proposals;
  } catch (err) {
    clearTimeout(timeoutId);
    logger.warn({ err: err.message }, 'self-improve: proposal generation failed');
    return [];
  }
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

function extractAlternationTerms(pattern) {
  const match = pattern.match(/\(([^)]+)\)/);
  if (!match) return new Set();
  return new Set(match[1].split('|').map(t => t.trim().toLowerCase()));
}

function isSubsetOrDuplicate(newPattern, existingRules) {
  const newTerms = extractAlternationTerms(newPattern);
  if (newTerms.size === 0) return false;

  for (const rule of existingRules) {
    const existingTerms = extractAlternationTerms(rule.pattern);
    if (existingTerms.size === 0) continue;

    // Check if new is a subset of existing (every new term is in existing)
    let isSubset = true;
    for (const term of newTerms) {
      if (!existingTerms.has(term)) { isSubset = false; break; }
    }
    if (isSubset) return true;

    // Check if existing is a subset of new (new supersedes existing — allow, but flag)
    // We allow superseding — the new rule replaces the narrower one
  }
  return false;
}

// ============================================================================
// VALIDATION
// ============================================================================

async function validateProposal(proposal) {
  const { testPatternSafety, runFullEval } = await import('../../eval/router-eval.js');

  const safety = testPatternSafety(proposal.pattern, proposal.category);
  if (!safety.safe) {
    return {
      valid: false,
      reason: `cross-contamination: ${safety.contamination.map(c => `"${c.msg}" (${c.category})`).join(', ')}`,
    };
  }

  try {
    const regex = new RegExp(proposal.pattern);
    const matchedAny = proposal.matches.split(',').some(m => regex.test(m.trim().toLowerCase()));
    if (!matchedAny) return { valid: false, reason: 'pattern does not match any claimed messages' };
  } catch (err) {
    return { valid: false, reason: `invalid regex: ${err.message}` };
  }

  const baseline = runFullEval();
  if (baseline.overall < 0.95) {
    return { valid: false, reason: `baseline accuracy too low: ${(baseline.overall * 100).toFixed(1)}%` };
  }

  return { valid: true, baselineAccuracy: baseline.overall };
}

// ============================================================================
// EVAL EXPANSION — grow the safety net with each improvement
// ============================================================================

function loadLearnedEvalLabels() {
  try {
    if (!existsSync(LEARNED_EVAL_FILE)) return { version: 1, labels: [] };
    return JSON.parse(readFileSync(LEARNED_EVAL_FILE, 'utf-8'));
  } catch { return { version: 1, labels: [] }; }
}

function expandEvalLabels(appliedRules, probeMisses) {
  const data = loadLearnedEvalLabels();

  for (const rule of appliedRules) {
    // Add probe messages that generated this rule as positive test cases
    const probeMessages = probeMisses[rule.category] || [];
    const regex = new RegExp(rule.pattern);

    for (const msg of probeMessages) {
      if (regex.test(msg.toLowerCase())) {
        // Only add if not already in labels
        if (!data.labels.some(l => l.msg.toLowerCase() === msg.toLowerCase())) {
          data.labels.push({
            msg,
            expected: rule.category,
            source: rule.ruleId,
            added: new Date().toISOString(),
          });
        }
      }
    }
  }

  writeFileSync(LEARNED_EVAL_FILE, JSON.stringify(data, null, 2));
  logger.info({ labels: data.labels.length }, 'self-improve: eval labels expanded');
}

// ============================================================================
// RULE GRADUATION — promote battle-tested rules to permanent
// ============================================================================

function graduateRules() {
  const data = loadLearnedRulesFile();
  let graduated = 0;

  for (const rule of data.rules) {
    if (rule.graduated) continue;
    if (!rule.survivedCycles) rule.survivedCycles = 0;
    rule.survivedCycles++;

    if (rule.survivedCycles >= GRADUATION_CYCLES) {
      rule.graduated = true;
      rule.graduatedAt = new Date().toISOString();
      graduated++;
    }
  }

  if (graduated > 0) {
    writeFileSync(LEARNED_RULES_FILE, JSON.stringify(data, null, 2));
    logger.info({ graduated }, 'self-improve: rules graduated to permanent');
  }

  return graduated;
}

// ============================================================================
// APPLICATION
// ============================================================================

function loadLearnedRulesFile() {
  try {
    if (!existsSync(LEARNED_RULES_FILE)) return { version: 1, lastModified: null, rules: [] };
    return JSON.parse(readFileSync(LEARNED_RULES_FILE, 'utf-8'));
  } catch { return { version: 1, lastModified: null, rules: [] }; }
}

function applyProposal(proposal, cycleId) {
  const data = loadLearnedRulesFile();

  // Exact duplicate check
  if (data.rules.some(r => r.pattern === proposal.pattern)) {
    return { applied: false, reason: 'duplicate pattern' };
  }

  // Subset check — skip if new pattern is a subset of existing same-category rules
  const sameCatRules = data.rules.filter(r => r.category === proposal.category);
  if (isSubsetOrDuplicate(proposal.pattern, sameCatRules)) {
    return { applied: false, reason: 'subset of existing rule' };
  }

  const ruleId = `lr-${Date.now().toString(36)}`;
  data.rules.push({
    id: ruleId,
    category: proposal.category,
    pattern: proposal.pattern,
    added: new Date().toISOString(),
    source: cycleId,
    reason: proposal.reason,
    matches: proposal.matches,
    approved: true,
    survivedCycles: 0,
    graduated: false,
  });
  data.lastModified = new Date().toISOString();

  writeFileSync(LEARNED_RULES_FILE, JSON.stringify(data, null, 2));
  reloadLearnedRules();

  return { applied: true, ruleId };
}

function logCycleResult(result) {
  try {
    appendFileSync(CYCLE_LOG_FILE, JSON.stringify(result) + '\n');
  } catch (err) {
    logger.warn({ err: err.message }, 'self-improve: failed to log cycle result');
  }
}

// ============================================================================
// MAIN CYCLE — multi-iteration overnight improvement
// ============================================================================

export async function runImprovementCycle(sendFn = null) {
  const cycleId = `cycle-${Date.now().toString(36)}`;
  const cycleStart = Date.now();

  logger.info({ cycleId, maxIterations: MAX_ITERATIONS, maxDurationMin: MAX_DURATION_MS / 60000 }, 'self-improve: starting overnight cycle');

  const result = {
    cycleId,
    timestamp: new Date().toISOString(),
    iterations: 0,
    analyzed: 0,
    totalProbes: 0,
    totalMisses: 0,
    proposals: [],
    applied: [],
    rejected: [],
    graduated: 0,
    evalLabelsAdded: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    // Read telemetry once (supplementary)
    const entries = readTelemetry(7);
    result.analyzed = entries.length;
    const telemetryMisses = entries.length >= MIN_SAMPLES_TO_ANALYZE
      ? findKeywordMisses(entries) : {};

    // --- Multi-iteration loop ---
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (Date.now() - cycleStart > MAX_DURATION_MS) {
        logger.info({ iteration: iter, elapsed: Date.now() - cycleStart }, 'self-improve: time limit reached');
        break;
      }

      result.iterations = iter + 1;
      logger.info({ iteration: iter + 1 }, 'self-improve: starting iteration');

      // 1. Synthetic probes (fresh each iteration — temperature varies)
      const probeMisses = await generateProbeMessages(iter);
      const probeCount = Object.values(probeMisses).reduce((s, msgs) => s + msgs.length, 0);
      result.totalProbes += Object.values(probeMisses).reduce((s, msgs) => s + msgs.length, 0);

      // 2. Merge with telemetry (only on first iteration)
      const misses = { ...probeMisses };
      if (iter === 0) {
        for (const [cat, msgs] of Object.entries(telemetryMisses)) {
          misses[cat] = [...(misses[cat] || []), ...msgs];
        }
      }

      const missCount = Object.values(misses).reduce((s, msgs) => s + msgs.length, 0);
      result.totalMisses += missCount;

      if (missCount === 0) {
        logger.info({ iteration: iter + 1 }, 'self-improve: no gaps found, converged');
        break;
      }

      // 3. Generate and apply proposals
      let iterApplied = 0;

      for (const [category, messages] of Object.entries(misses)) {
        if (messages.length < MIN_MISSES_PER_CATEGORY) continue;
        if (iterApplied >= MAX_RULES_PER_ITERATION) break;
        if (Date.now() - cycleStart > MAX_DURATION_MS) break;

        const uniqueMessages = [...new Set(messages.map(m => m.toLowerCase().trim()))];
        if (uniqueMessages.length < MIN_MISSES_PER_CATEGORY) continue;

        logger.info({ category, misses: uniqueMessages.length, iteration: iter + 1 }, 'self-improve: generating proposals');

        try {
          const proposals = await generateProposals(category, uniqueMessages);
          result.proposals.push(...proposals);

          for (const proposal of proposals) {
            if (iterApplied >= MAX_RULES_PER_ITERATION) break;

            const validation = await validateProposal(proposal);
            if (!validation.valid) {
              result.rejected.push({ pattern: proposal.pattern, category, reason: validation.reason });
              continue;
            }

            const application = applyProposal(proposal, cycleId);
            if (application.applied) {
              result.applied.push({ ruleId: application.ruleId, category, pattern: proposal.pattern, reason: proposal.reason });
              iterApplied++;
              logger.info({ ruleId: application.ruleId, category, pattern: proposal.pattern, iteration: iter + 1 }, 'self-improve: rule applied');
            } else {
              result.rejected.push({ pattern: proposal.pattern, category, reason: application.reason });
            }
          }
        } catch (err) {
          result.errors.push({ category, iteration: iter + 1, error: err.message });
        }
      }

      // 4. Post-iteration validation
      if (iterApplied > 0) {
        try {
          const { runFullEval } = await import('../../eval/router-eval.js');
          const postEval = runFullEval();

          if (postEval.overall < 0.95) {
            logger.warn({ accuracy: postEval.overall, iteration: iter + 1 }, 'self-improve: accuracy dropped, rolling back iteration');
            const data = loadLearnedRulesFile();
            const iterRuleIds = result.applied.slice(-iterApplied).map(r => r.ruleId);
            data.rules = data.rules.filter(r => !iterRuleIds.includes(r.id));
            writeFileSync(LEARNED_RULES_FILE, JSON.stringify(data, null, 2));
            reloadLearnedRules();
            result.applied = result.applied.slice(0, -iterApplied);
            continue; // try next iteration anyway
          }
        } catch (err) {
          result.errors.push({ phase: 'post-eval', iteration: iter + 1, error: err.message });
        }

        // 5. Expand eval labels with newly applied rules
        try {
          const labelsBefore = loadLearnedEvalLabels().labels.length;
          expandEvalLabels(result.applied.slice(-iterApplied), probeMisses);
          result.evalLabelsAdded += loadLearnedEvalLabels().labels.length - labelsBefore;
        } catch (err) {
          result.errors.push({ phase: 'eval-expansion', error: err.message });
        }
      }

      // If nothing applied this iteration, we've converged
      if (iterApplied === 0) {
        logger.info({ iteration: iter + 1 }, 'self-improve: no improvements this iteration, converged');
        break;
      }
    }

    // --- Post-loop: graduate battle-tested rules ---
    result.graduated = graduateRules();

  } catch (err) {
    result.errors.push({ phase: 'cycle', error: err.message });
    logger.error({ err: err.message }, 'self-improve: cycle failed');
  }

  result.durationMs = Date.now() - cycleStart;
  logCycleResult(result);

  // --- Notify via WhatsApp ---
  if (sendFn) {
    try {
      const lines = [`*Overnight Self-Improvement* (${cycleId})`];
      lines.push(`Iterations: ${result.iterations}/${MAX_ITERATIONS}`);
      lines.push(`Probes: ${result.totalProbes} messages tested`);
      lines.push(`Keyword gaps found: ${result.totalMisses}`);
      lines.push(`Proposals: ${result.proposals.length}`);
      lines.push(`*Applied: ${result.applied.length}*`);
      if (result.applied.length > 0) {
        for (const r of result.applied) {
          lines.push(`  + [${r.category}] ${r.pattern}`);
        }
      }
      if (result.rejected.length > 0) lines.push(`Rejected: ${result.rejected.length}`);
      if (result.graduated > 0) lines.push(`Graduated: ${result.graduated} rules → permanent`);
      if (result.evalLabelsAdded > 0) lines.push(`Eval expanded: +${result.evalLabelsAdded} test cases`);
      const totalRules = loadLearnedRulesFile().rules.length;
      lines.push(`Total learned rules: ${totalRules}`);
      lines.push(`Duration: ${(result.durationMs / 1000).toFixed(0)}s`);
      if (result.errors.length > 0) lines.push(`Errors: ${result.errors.length}`);
      await sendFn(lines.join('\n'));
    } catch (err) {
      logger.warn({ err: err.message }, 'self-improve: notification failed');
    }
  }

  logger.info({
    cycleId, iterations: result.iterations,
    proposals: result.proposals.length, applied: result.applied.length,
    rejected: result.rejected.length, graduated: result.graduated,
    evalLabelsAdded: result.evalLabelsAdded, durationMs: result.durationMs,
  }, 'self-improve: overnight cycle complete');

  return result;
}

// Status summary
export function getSelfImproveStatus() {
  const rules = loadLearnedRulesFile();
  const evalLabels = loadLearnedEvalLabels();
  let recentCycles = [];
  try {
    if (existsSync(CYCLE_LOG_FILE)) {
      const lines = readFileSync(CYCLE_LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
      recentCycles = lines.slice(-5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
  } catch { /* ignore */ }

  return {
    learnedRules: rules.rules.length,
    graduatedRules: rules.rules.filter(r => r.graduated).length,
    evalLabels: evalLabels.labels.length,
    lastModified: rules.lastModified,
    recentCycles: recentCycles.map(c => ({
      cycleId: c.cycleId, timestamp: c.timestamp,
      iterations: c.iterations, applied: c.applied?.length || 0,
      rejected: c.rejected?.length || 0,
    })),
  };
}
