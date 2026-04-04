// src/tasks/forge-orchestrator.js — Forge overnight orchestrator
//
// Runs at 22:30 London time. Coordinates 7 phases of autonomous improvement:
// 1. Intelligence Gathering (EVO 30B) — reads traces, logs, skills, past reports
// 2. Architect (Opus via Claude Code CLI on EVO) — detailed spec for #1 opportunity
// 3. Implement + Test (Opus via Claude Code CLI on EVO) — TDD on forge/ branch
// 4. Review (fresh Opus session) — validates diff against spec, DGM gate
// 5. Deploy or Queue — auto-deploy if safe, else queue for morning approval
// 6. Meta-Improvement (Opus) — targets eval/prompt improvements
// 7. Report — generates overnight report, sends WhatsApp summary

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import config from '../config.js';
import logger from '../logger.js';
import { evoFetch, llamaBreaker } from '../evo-client.js';
import { createTask } from '../evolution.js';
import { loadSkills } from '../skill-registry.js';

const execAsync = promisify(execFile);

// --- Paths ---
const DATA_DIR = join('data', 'forge');
const PROMPTS_DIR = join(DATA_DIR, 'prompts');
const SPECS_DIR = join(DATA_DIR, 'specs');
const REPORTS_DIR = join(DATA_DIR, 'reports');
const HISTORY_FILE = join(DATA_DIR, 'history.jsonl');

// --- Phase timeouts (ms) ---
const PHASE_TIMEOUT = {
  analysis: 30 * 60 * 1000,
  nightlyTouch: 15 * 60 * 1000,
  architect: 30 * 60 * 1000,
  implement: 2 * 60 * 60 * 1000,
  review: 30 * 60 * 1000,
  meta: 60 * 60 * 1000,
};

// Bot now runs on EVO — all execution is local
const REPO_DIR = process.cwd();

let lastForgeDate = null;

// --- Exports ---

export async function checkForge(sendFn, todayStr, hours, minutes) {
  if (lastForgeDate === todayStr) return;
  // Forge runs at 04:00 (was 04:30 — shifted to give 3h before 07:00 hard stop).
  // Consumes: dream diary (22:05), deep think (23:00), self-improve (01:00),
  // extraction (02:00), trace analysis (03:00), ground truth (03:30).
  if (hours !== 4 || minutes < 0) return;

  lastForgeDate = todayStr;
  logger.info('forge: starting overnight session');

  // Pre-flight: check Claude Code CLI is available and authenticated for phases 2-6
  let claudeCliAvailable = false;
  try {
    // 1. Check the binary exists
    const { stdout: binCheck } = await localExec(
      'test -x ~/.local/bin/claude && echo ok || which claude 2>/dev/null || echo missing',
      5000,
    );
    const binFound = binCheck.includes('ok') || (binCheck.includes('/') && !binCheck.includes('missing'));

    if (!binFound) {
      logger.error('forge: claude CLI not found — phases 2-6 will be skipped. Install via: npm install -g @anthropic-ai/claude-code');
    } else {
      // 2. Verify authentication — if using subscription, check OAuth creds exist
      //    `claude auth status` exits 0 and prints account info when authenticated
      const authCmd = config.forgeUseSubscription
        ? 'env -u ANTHROPIC_API_KEY ~/.local/bin/claude auth status 2>&1 || echo AUTH_FAIL'
        : 'echo API_KEY_MODE';
      const { stdout: authCheck } = await localExec(authCmd, 10000);

      if (authCheck.includes('AUTH_FAIL') || authCheck.includes('not logged in') || authCheck.includes('No account')) {
        logger.error(
          'forge: claude CLI not authenticated with Max subscription. Run: claude login',
        );
        // Fall back to API key mode if available
        if (config.anthropicApiKey) {
          logger.warn('forge: falling back to API key mode — will use API credits');
          claudeCliAvailable = true;
        }
      } else {
        claudeCliAvailable = true;
        const mode = config.forgeUseSubscription ? 'Max subscription' : 'API key';
        logger.info({ mode, model: config.forgeClaudeModel }, 'forge: claude CLI ready');
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'forge: claude CLI check failed — phases 2-6 will be skipped');
  }

  const session = {
    date: todayStr,
    startedAt: new Date().toISOString(),
    phases: {},
    errors: [],
    tasks: [],
  };

  try {
    // Phase 1: Intelligence Gathering
    if (isBeforeHardStop()) {
      session.phases.analysis = await runPhase('analysis', () => phaseIntelligence(session));
    }

    // Phase 1.5: Nightly touch — always runs, edits text files directly (no branch)
    // Produces a real committed change every night even if Phases 2-4 don't complete.
    if (claudeCliAvailable && isBeforeHardStop() && session.phases.analysis?.brief) {
      session.phases.nightlyTouch = await runPhase('nightlyTouch', () => phaseNightlyTouch(session));
    }

    // Phase 2: Architect — requires Claude Code CLI
    if (claudeCliAvailable && isBeforeHardStop() && session.phases.analysis?.brief) {
      session.phases.architect = await runPhase('architect', () => phaseArchitect(session));
    }

    // Phase 3: Implement + Test — only if 60+ minutes remain (needs enough for TDD cycle)
    if (claudeCliAvailable && isBeforeHardStop() && remainingMinutes() >= 60 && session.phases.architect?.spec) {
      session.phases.implement = await runPhase('implement', () => phaseImplement(session));
    } else if (session.phases.architect?.spec && !isBeforeHardStop()) {
      logger.warn('forge: skipping implement — past hard stop');
    } else if (session.phases.architect?.spec && remainingMinutes() < 60) {
      logger.warn({ remainingMinutes: Math.round(remainingMinutes()) }, 'forge: skipping implement — less than 60 min remaining');
    }

    // Phase 4: Review — requires Claude Code CLI
    if (claudeCliAvailable && isBeforeHardStop() && session.phases.implement?.branch) {
      session.phases.review = await runPhase('review', () => phaseReview(session));
    }

    // Phase 5: Deploy or Queue
    if (isBeforeHardStop() && session.phases.review?.verdict) {
      session.phases.deploy = await runPhase('deploy', () => phaseDeploy(session, sendFn));
    }

    // Phase 6: Meta-Improvement — requires Claude Code CLI
    if (claudeCliAvailable && isBeforeHardStop()) {
      session.phases.meta = await runPhase('meta', () => phaseMeta(session));
    }
  } catch (err) {
    session.errors.push({ phase: 'orchestrator', error: err.message });
    logger.error({ err: err.message }, 'forge: orchestrator-level error');
  }

  // Phase 7: Report (always runs)
  session.phases.report = await runPhase('report', () => phaseReport(session, sendFn));
  session.finishedAt = new Date().toISOString();

  // Persist to history
  appendToHistory(session);
  logger.info({ phases: Object.keys(session.phases) }, 'forge: session complete');
}

export function getLastForgeDate() {
  return lastForgeDate;
}

export function getLatestForgeReport() {
  try {
    ensureDir(REPORTS_DIR);
    const latest = readdirSync(REPORTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-1)[0];
    if (!latest) return null;
    return JSON.parse(readFileSync(join(REPORTS_DIR, latest), 'utf-8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'forge: failed to read latest report');
    return null;
  }
}

// --- Time guards ---

/**
 * Compute the hard-stop timestamp in ms.
 * Uses current London time to calculate minutes until stopHour:00.
 * Handles the overnight window correctly:
 *   - 04:30 London → 07:00 London same morning = 150 min
 *   - 22:30 London → 07:00 London next morning = 510 min
 *   - 08:00 London (daytime, past stop) → returns Date.now()-1 so isBeforeHardStop() = false
 */
function getHardStopMs() {
  const stopHour = config.forgeHardStopHour ?? 7;

  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    parts[type] = value;
  }
  const h = parseInt(parts.hour, 10);
  const m = parseInt(parts.minute, 10);

  let minsUntilStop;
  if (h < stopHour) {
    // Early morning, before the stop — stop is later today
    minsUntilStop = (stopHour - h) * 60 - m;
  } else if (h >= 22) {
    // Evening — forge starts overnight, stop is next morning
    minsUntilStop = (24 - h + stopHour) * 60 - m;
  } else {
    // Daytime (stopHour ≤ h < 22) — already past the stop for today
    return Date.now() - 1;
  }

  return Date.now() + minsUntilStop * 60 * 1000;
}

/** Returns true if we still have time to run more phases. */
function isBeforeHardStop() {
  return Date.now() < getHardStopMs();
}

/** Returns minutes remaining before the hard stop. */
function remainingMinutes() {
  return Math.max(0, (getHardStopMs() - Date.now()) / 60000);
}

// --- Phase runner with timeout and error isolation ---

async function runPhase(name, fn) {
  const timeout = PHASE_TIMEOUT[name] || 30 * 60 * 1000;
  const start = Date.now();
  logger.info({ phase: name }, 'forge: phase starting');

  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Phase ${name} timed out`)), timeout)),
    ]);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info({ phase: name, elapsed: `${elapsed}s` }, 'forge: phase complete');
    return { ...result, elapsed: parseFloat(elapsed), status: 'ok' };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.error({ phase: name, err: err.message, elapsed: `${elapsed}s` }, 'forge: phase failed');
    return { status: 'error', error: err.message, elapsed: parseFloat(elapsed) };
  }
}

// --- Local execution helpers (bot runs on EVO now) ---

async function localExec(command, timeoutMs = 60000) {
  const { stdout, stderr } = await execAsync('bash', ['-c', command], {
    timeout: timeoutMs,
    cwd: REPO_DIR,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runClaudeCode(promptContent, timeoutMs = PHASE_TIMEOUT.implement) {
  const { writeFileSync: wfs } = await import('fs');
  wfs('/tmp/forge-prompt.md', promptContent);

  const model = config.forgeClaudeModel || 'claude-opus-4-6';

  // If using Max subscription, unset ANTHROPIC_API_KEY so the CLI uses OAuth credentials.
  // `env -u VAR cmd` removes the variable from the child process environment cleanly.
  // Without this, Claude Code CLI would pick up the bot's API key and bill against it.
  const envPrefix = config.forgeUseSubscription ? 'env -u ANTHROPIC_API_KEY' : '';

  const cmd = `cd ${REPO_DIR} && ${envPrefix} ~/.local/bin/claude -p --model ${model} --allowedTools "Edit,Write,Read,Bash,Glob,Grep" < /tmp/forge-prompt.md`;
  const result = await localExec(cmd, timeoutMs);
  return result.stdout;
}

// --- EVO 30B helper ---

async function queryEvo30B(systemPrompt, userPrompt, maxTokens = 4000) {
  const resp = await llamaBreaker.call(async () => {
    const r = await evoFetch(`${config.evoLlmUrl}/v1/chat/completions`, {
      method: 'POST',
      timeout: PHASE_TIMEOUT.analysis,
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });
    return r.json();
  }, { choices: [] });
  return resp.choices?.[0]?.message?.content || '';
}

// --- File helpers ---

function readOptional(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf-8') : null; } catch { return null; }
}

function readPrompt(name) {
  const path = join(PROMPTS_DIR, name);
  if (!existsSync(path)) throw new Error(`Missing prompt: ${name}`);
  return readFileSync(path, 'utf-8');
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendToHistory(session) {
  ensureDir(DATA_DIR);
  appendFileSync(HISTORY_FILE, JSON.stringify(session) + '\n', 'utf-8');
}

// --- Phase 1: Intelligence Gathering ---

async function phaseIntelligence(session) {
  const systemPrompt = readPrompt('analyst.md');

  // Gather structured data — all freshly written by earlier overnight tasks
  const traceAnalysis = readOptional(join('data', 'trace-analysis.json'));
  const learnedRules = readOptional(join('data', 'learned-rules.json'));
  const groundTruth = readOptional(join('data', 'ground-truth.json'));
  const selfImproveLog = readOptional(join('data', 'self-improve-log.jsonl'));
  const weeklyRetro = readOptional(join('data', 'weekly-retrospective.json'));

  // --- Actual conversation samples (not just counts) ---
  // Read the last 150 messages from yesterday's logs, including bot responses.
  // This is what the analyst actually needs to spot patterns.
  let conversationSamples = 'No recent conversation logs.';
  const logsDir = join('data', 'conversation-logs');
  if (existsSync(logsDir)) {
    const files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl')).sort().slice(-2);
    const messages = [];
    for (const f of files) {
      try {
        const lines = readFileSync(join(logsDir, f), 'utf-8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.text && msg.text.length > 3) {
              messages.push(`[${(msg.timestamp || '').split('T')[1]?.slice(0, 5) || '?'}] ${msg.isBot ? 'Clawd' : (msg.sender || 'User')}: ${msg.text.slice(0, 200)}`);
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* skip unreadable file */ }
    }
    if (messages.length > 0) {
      // Keep the last 150 messages — enough for pattern spotting, not so many the model loses focus
      const sample = messages.slice(-150);
      conversationSamples = `${messages.length} messages total. Last ${sample.length} shown:\n\n${sample.join('\n')}`;
    }
  }

  // --- Quality gate rejections from the last 7 days ---
  // These are responses the quality gate rejected before sending — high-signal failure data.
  let qualityFailures = 'No quality gate data.';
  const qualityLog = readOptional(join('data', 'quality-gate-rejections.jsonl'));
  if (qualityLog) {
    const lines = qualityLog.trim().split('\n').filter(Boolean).slice(-30);
    qualityFailures = `Last ${lines.length} quality gate rejections:\n` +
      lines.map(l => { try { const r = JSON.parse(l); return `[${r.category}] "${r.prompt?.slice(0, 100)}"→ rejected: ${r.reason}`; } catch { return l; } }).join('\n');
  }

  // --- Dream insights from memory service (direct evidence from overnight diary) ---
  let dreamInsights = 'Memory service not available.';
  try {
    const { evoFetchJSON } = await import('../evo-client.js');
    const resp = await evoFetchJSON(`${config.evoMemoryUrl}/memory/search`, {
      method: 'POST',
      body: JSON.stringify({ query: 'insight observation pattern behaviour', category: 'insight', limit: 15 }),
      timeout: 15000,
    });
    if (resp?.results?.length > 0) {
      dreamInsights = resp.results
        .map(r => `- [${r.memory?.sourceDate || '?'}] ${r.memory?.fact || r.fact || ''}`)
        .join('\n');
    } else {
      dreamInsights = 'No insights in memory service yet.';
    }
  } catch { dreamInsights = 'Could not query memory service.'; }

  // Previous forge reports (with more context than before)
  let prevReports = '';
  ensureDir(REPORTS_DIR);
  const reportFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().slice(-7);
  if (reportFiles.length) {
    prevReports = reportFiles.map(f => {
      const data = readOptional(join(REPORTS_DIR, f));
      if (!data) return '';
      try {
        const r = JSON.parse(data);
        const touch = r.nightlyTouchFiles?.length ? ` touch:${r.nightlyTouchFiles.join(',')}` : '';
        return `${f}: spec=${r.spec || 'none'} deploy=${r.deployAction || 'none'}${touch}`;
      } catch { return f; }
    }).join('\n');
  }

  // Skill metrics
  let skillInfo = 'No skills loaded.';
  try {
    const skills = await loadSkills();
    if (skills.length > 0) {
      skillInfo = skills.map(s => `${s.name} v${s.version || '?'}: triggered=${s.metrics?.timesTriggered || 0} success=${s.metrics?.successRate?.toFixed(2) || '?'}`).join('\n');
    }
  } catch { /* non-fatal */ }

  // Self-improve summary
  let selfImproveSummary = 'No self-improvement data.';
  if (selfImproveLog) {
    const lines = selfImproveLog.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      try {
        const last = JSON.parse(lines[lines.length - 1]);
        selfImproveSummary = `Iterations: ${last.iterations}, Probes: ${last.totalProbes}, Misses: ${last.totalMisses}, Proposals: ${last.proposals?.length || 0}`;
      } catch { /* use default */ }
    }
  }

  // Ground truth gaps
  let groundTruthSummary = 'No ground truth data yet.';
  if (groundTruth) {
    try {
      const gt = JSON.parse(groundTruth);
      const total = gt.entries?.length || 0;
      const unverified = gt.entries?.filter(e => !e.verified)?.length || 0;
      groundTruthSummary = `${total} entries, ${unverified} unverified claims`;
    } catch { /* use default */ }
  }

  const userPrompt = [
    '## Conversation Samples (actual messages — primary signal)',
    conversationSamples,
    '## Quality Gate Rejections',
    qualityFailures,
    '## Dream Insights (from memory service)',
    dreamInsights,
    '## Trace Analysis', traceAnalysis || 'No trace analysis available.',
    '## Self-Improvement (tonight)', selfImproveSummary,
    '## Ground Truth', groundTruthSummary,
    '## Weekly Retrospective', weeklyRetro || 'No retrospective available.',
    '## Previous Forge Reports (last 7)', prevReports || 'No previous reports.',
    '## Skill Metrics', skillInfo,
    '## Learned Rules', learnedRules ? `${JSON.parse(learnedRules || '{}')?.rules?.length || 0} learned rules in router` : 'None.',
  ].join('\n\n');

  const brief = await queryEvo30B(systemPrompt, userPrompt, 6000);
  return { brief };
}

// --- Phase 1.5: Nightly Touch ---
// Lightweight prompt/knowledge improvement that runs every night.
// Edits text files directly on main — no branch, no TDD, no 3-gate review.
// This ensures every Forge session produces at least one committed improvement.
// Target files: data/forge/prompts/*.md, data/system-knowledge/*.json, soul entries.

const NIGHTLY_TOUCH_PROMPT = `# Nightly Touch — Lightweight Improvement

You have access to the full brief from tonight's intelligence gathering. Your job is to make ONE small, concrete improvement to a text or config file that does not require code changes to core logic.

## Brief
{BRIEF}

## Previous 7 nights of nightly touches
{PREV_TOUCHES}

## Allowed targets — pick the ONE with highest value tonight

### Text files (always safe, commit directly to main)
1. \`data/forge/prompts/analyst.md\` — improve if tonight's brief was thin or missed obvious patterns
2. \`data/forge/prompts/architect.md\` — refine auto-deploy classification or spec structure
3. \`data/forge/prompts/reviewer.md\` — adjust verdict guidance if review decisions seem off
4. \`data/system-knowledge/*.json\` — update any stale facts about Clawd's own capabilities
5. \`evo-memory/dream_mode.py\` — DREAM_PROMPT only — if diary entries were too long/short/missing sections

### Skill improvements (safe if tests still pass, commit to main)
6. \`src/skills/*.js\` canHandle only — if a skill has 0 invocations but the pattern clearly exists in tonight's conversations, add matching phrases to canHandle. Do NOT change execute logic.

### Eval coverage (always safe)
7. \`data/learned-eval-labels.json\` — add 3-5 new labelled examples from tonight's conversations to improve future routing eval. Format: [{"text":"...", "expected_category":"..."}]. Only add examples where the correct category is unambiguous.

### Soul/insight entry (append only)
8. New insight via curl: \`curl -s -X POST http://localhost:5100/memory/store -H 'Content-Type: application/json' -d '{"fact":"...","category":"insight","tags":["forge","nightly"],"confidence":0.8,"source":"forge"}'\`

## What makes a good nightly touch
- Directly addresses a specific pattern from tonight's conversation samples or insights
- Changes fewer than 25 lines
- Not a repeat of the last 7 nights
- For skills: don't broaden canHandle so far it starts matching unrelated messages — add 2-4 specific phrases maximum
- For eval labels: only add examples you're certain about from tonight's actual conversations

## Instructions
1. Read the brief and previous touches
2. Identify the single best improvement (prefer text files — lowest risk)
3. Read the target file first before editing
4. Make the edit
5. \`git add -A && git commit -m "forge/nightly-touch: <concise description>"\`
6. Output JSON: { "action": "improved" | "none", "target": "filepath or memory-store", "description": "what changed", "reasoning": "why this matters" }

If nothing warrants changing tonight, output { "action": "none", "reason": "explain why" } and do NOT commit.`;

async function phaseNightlyTouch(session) {
  const brief = session.phases.analysis?.brief || 'No brief available.';
  const { stdout: beforeHead } = await localExec(`cd ${REPO_DIR} && git rev-parse HEAD`, 10000);

  // Build context from last 7 nightly touches
  const reports = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().slice(-7);
  const prevTouches = reports.map(f => {
    const data = readOptional(join(REPORTS_DIR, f));
    if (!data) return '';
    try {
      const r = JSON.parse(data);
      if (!r.nightlyTouchFiles?.length && r.nightlyTouchAction !== 'improved') return '';
      return `${f}: ${r.nightlyTouchFiles?.join(', ') || 'none'} — ${r.nightlyTouchAction || 'none'}`;
    } catch { return ''; }
  }).filter(Boolean).join('\n') || 'No previous touches.';

  const prompt = NIGHTLY_TOUCH_PROMPT
    .replace('{BRIEF}', brief.slice(0, 3000))
    .replace('{PREV_TOUCHES}', prevTouches);

  const output = await runClaudeCode(prompt, 15 * 60 * 1000); // 15 min max

  let result = null;
  const jsonMatch = output.match(/```json\n([\s\S]*?)```/) || output.match(/\{[\s\S]*"action"[\s\S]*\}/);
  if (jsonMatch) {
    try { result = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch { /* fallback */ }
  }
  if (!result) {
    result = { action: 'unknown', description: output.slice(0, 300) };
  }

  // Get the list of files actually changed only if the touch created a new commit.
  let files = [];
  try {
    const { stdout: afterHead } = await localExec(`cd ${REPO_DIR} && git rev-parse HEAD`, 10000);
    if (afterHead !== beforeHead) {
      const { stdout } = await localExec(`cd ${REPO_DIR} && git diff --name-only ${beforeHead} ${afterHead}`, 10000);
      files = stdout.split('\n').filter(Boolean);
    }
  } catch { /* non-fatal */ }

  logger.info({ action: result.action, target: result.target, files }, 'forge: nightly touch complete');
  return { action: result.action, files, description: result.description, reasoning: result.reasoning };
}

// --- Phase 2: Architect ---

async function phaseArchitect(session) {
  const architectPrompt = readPrompt('architect.md');
  const brief = session.phases.analysis.brief;

  const prompt = `${architectPrompt}\n\n## Tonight's Brief\n\n${brief}\n\n## Instructions\n\nProduce a detailed spec for the #1 ranked opportunity. Output JSON with fields: title, description, files_to_modify, approach, tests, auto_deployable (boolean), risks.`;

  const output = await runClaudeCode(prompt, PHASE_TIMEOUT.architect);

  // Parse spec from output (look for JSON block)
  let spec = null;
  const jsonMatch = output.match(/```json\n([\s\S]*?)```/) || output.match(/\{[\s\S]*"title"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      spec = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    } catch { /* fallback below */ }
  }

  if (!spec) {
    // Store raw output as spec with minimal structure
    spec = { title: 'forge-task', description: output.slice(0, 500), raw_output: output, auto_deployable: false };
  }

  // Save spec
  ensureDir(SPECS_DIR);
  const specFile = join(SPECS_DIR, `${session.date}-task-1.json`);
  writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf-8');

  return { spec, specFile };
}

// --- Phase 3: Implement + Test ---

async function phaseImplement(session) {
  const spec = session.phases.architect.spec;
  const testerPrompt = readPrompt('tester.md');
  const branch = `forge/${session.date}-${spec.title?.replace(/[^a-z0-9]+/gi, '-').slice(0, 30).toLowerCase() || 'task'}`;

  // Create branch on EVO
  await localExec(`cd ${REPO_DIR} && git checkout main && git pull && git checkout -b ${branch}`, 30000);

  const prompt = [
    testerPrompt,
    '',
    '## Spec',
    JSON.stringify(spec, null, 2),
    '',
    '## Instructions',
    'Implement the spec above using TDD. Write tests first, then implementation.',
    `You are on branch ${branch}. Commit your changes when done.`,
    'Files to modify: ' + (spec.files_to_modify || []).join(', '),
  ].join('\n');

  const output = await runClaudeCode(prompt, PHASE_TIMEOUT.implement);

  // Get diff info — write full diff to temp file, pass path to reviewer
  const { stdout: diffStat } = await localExec(`cd ${REPO_DIR} && git diff main --stat`, 15000);
  const { stdout: diffFull } = await localExec(`cd ${REPO_DIR} && git diff main`, 30000);
  const { stdout: filesChanged } = await localExec(`cd ${REPO_DIR} && git diff main --name-only`, 15000);

  const diffFile = `/tmp/forge-diff-${session.date}.patch`;
  writeFileSync(diffFile, diffFull, 'utf-8');

  return {
    branch,
    diffStat,
    diffFile,
    files: filesChanged.split('\n').filter(Boolean),
    implementOutput: output.slice(0, 2000),
  };
}

// --- Phase 4: Review ---

async function phaseReview(session) {
  const reviewerPrompt = readPrompt('reviewer.md');
  const spec = session.phases.architect.spec;
  const impl = session.phases.implement;

  const prompt = [
    reviewerPrompt,
    '',
    '## Spec',
    JSON.stringify(spec, null, 2),
    '',
    '## Diff',
    impl.diffFile
      ? `The full diff is at: ${impl.diffFile}\nRead it with: cat ${impl.diffFile}\n\nStat summary:\n${impl.diffStat || 'unavailable'}`
      : '```\nNo diff available\n```',
    '',
    '## Files Changed',
    (impl.files || []).join(', '),
    '',
    '## Instructions',
    'Review this diff against the spec. Read the full diff file above before forming your verdict.',
    'Output JSON with: verdict ("auto-deploy" or "needs-approval"), test_pass (boolean), eval_regression (boolean), issues (array of strings), summary (string).',
  ].join('\n');

  const output = await runClaudeCode(prompt, PHASE_TIMEOUT.review);

  let verdict = null;
  const jsonMatch = output.match(/```json\n([\s\S]*?)```/) || output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      verdict = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    } catch { /* fallback */ }
  }

  if (!verdict) {
    verdict = { verdict: 'needs-approval', test_pass: false, eval_regression: false, issues: ['Could not parse review output'], summary: output.slice(0, 500) };
  }

  return { verdict, reviewOutput: output.slice(0, 2000) };
}

// --- Phase 5: Deploy or Queue ---

// Core files that must never be touched by an auto-deploy, regardless of reviewer verdict.
const BANNED_CORE_FILES = new Set([
  'src/message-handler.js', 'src/router.js', 'src/claude.js', 'src/memory.js',
  'src/config.js', 'src/constants.js', 'src/output-filter.js', 'src/group-registry.js',
  'src/prompt.js', 'src/index.js', 'src/scheduler.js', 'src/cortex.js',
  'src/evo-llm.js', 'src/evo-client.js', 'src/task-planner.js',
]);

// Paths where changes are inherently sandboxed — can auto-deploy even if the
// reviewer conservatively said "needs-approval", as long as tests pass.
const SAFE_AUTO_DEPLOY_PATTERNS = [
  /^src\/skills\//,           // new or modified skills
  /^src\/skills$/,
  /^tests?\/skills?\//,       // skill tests
  /^data\//,                  // prompts, knowledge, eval labels
];

function classifyChangedFiles(files) {
  const bannedFiles = files.filter(f => BANNED_CORE_FILES.has(f));
  const allSafe = files.length > 0 && files.every(f =>
    SAFE_AUTO_DEPLOY_PATTERNS.some(re => re.test(f))
  );
  return { bannedFiles, allSafe };
}

async function phaseDeploy(session, sendFn) {
  const review = session.phases.review.verdict;
  const impl = session.phases.implement;
  const spec = session.phases.architect?.spec;
  const branch = impl.branch;
  const changedFiles = impl.files || [];

  const { bannedFiles, allSafe } = classifyChangedFiles(changedFiles);

  // Hard rule: banned core files → always queue for approval, no exceptions
  if (bannedFiles.length > 0) {
    logger.warn({ bannedFiles }, 'forge: banned core files touched — forcing needs-approval');
    return queueForApproval(session, sendFn, branch, review, spec,
      `Banned files modified: ${bannedFiles.join(', ')}`);
  }

  // File-based auto-deploy: if ALL files are in safe paths and tests pass,
  // override a conservative "needs-approval" reviewer verdict.
  const testsPassed = review.test_pass === true;
  const noRegression = review.eval_regression !== true;

  const canAutoDeployByFiles = allSafe && testsPassed && noRegression;

  // Reviewer + spec gate: reviewer said auto-deploy AND spec is flagged auto_deployable
  const canAutoDeployByReview =
    review.verdict === 'auto-deploy' &&
    testsPassed &&
    noRegression &&
    spec?.auto_deployable === true;

  const canAutoDeploy = canAutoDeployByFiles || canAutoDeployByReview;

  if (canAutoDeploy) {
    const reason = canAutoDeployByFiles && !canAutoDeployByReview
      ? 'file-safe-override'
      : 'reviewer-approved';
    logger.info({ reason, branch, files: changedFiles }, 'forge: auto-deploying');

    try {
      await localExec(`cd ${REPO_DIR} && git checkout main && git merge --no-ff ${branch}`, 30000);
      await loadSkills();
      return { action: 'auto-deployed', reason, branch, files: changedFiles };
    } catch (deployErr) {
      logger.error({ err: deployErr.message }, 'forge: auto-deploy failed, reverting');
      try {
        await localExec(`cd ${REPO_DIR} && git revert --no-commit HEAD && git commit -m "revert: forge auto-deploy failed"`, 30000);
      } catch { /* best effort */ }
      return { action: 'deploy-failed', error: deployErr.message, branch };
    }
  }

  return queueForApproval(session, sendFn, branch, review, spec);
}

function queueForApproval(session, sendFn, branch, review, spec, forcedReason = null) {
  const task = createTask(
    `Forge: ${spec?.title || 'overnight improvement'} — ${review.summary || 'see spec'}`,
    'forge',
    'normal',
  );
  session.tasks.push(task?.id);

  if (sendFn && config.ownerJid) {
    const reason = forcedReason || `Reviewer: ${review.verdict}`;
    const msg = [
      '*FORGE — Needs Approval*',
      `Branch: ${branch}`,
      `Files: ${(session.phases.implement?.files || []).join(', ')}`,
      `Reason: ${reason}`,
      review.summary || '',
      review.issues?.length ? `Issues: ${review.issues.join('; ')}` : '',
      '',
      `Task ${task?.id} queued. Reply "approve forge" to deploy.`,
    ].filter(Boolean).join('\n');
    sendFn(msg).catch(() => {});
  }

  return { action: 'queued', taskId: task?.id, branch };
}

// --- Phase 6: Meta-Improvement ---

async function phaseMeta(session) {
  const prompt = [
    '# Meta-Improvement Pass',
    '',
    'Review the forge session so far and identify ONE improvement to the evaluation, prompts, or routing system.',
    '',
    '## Session Summary',
    JSON.stringify({
      phases: Object.fromEntries(
        Object.entries(session.phases).map(([k, v]) => [k, { status: v?.status, elapsed: v?.elapsed }])
      ),
      errors: session.errors,
    }, null, 2),
    '',
    '## Instructions',
    'If you identify a concrete, scoped improvement (prompt tweak, eval rule, routing fix), implement it.',
    'If nothing actionable, output: { "action": "none", "reason": "..." }',
    'Otherwise implement the change and output: { "action": "implemented", "description": "...", "files": [...] }',
  ].join('\n');

  const output = await runClaudeCode(prompt, PHASE_TIMEOUT.meta);

  let result = null;
  const jsonMatch = output.match(/```json\n([\s\S]*?)```/) || output.match(/\{[\s\S]*"action"[\s\S]*\}/);
  if (jsonMatch) {
    try { result = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch { /* fallback */ }
  }

  return { metaOutput: output.slice(0, 2000), result: result || { action: 'unknown' } };
}

// --- Phase 7: Report ---

async function phaseReport(session, sendFn) {
  const report = {
    date: session.date,
    startedAt: session.startedAt,
    finishedAt: new Date().toISOString(),
    phases: Object.fromEntries(
      Object.entries(session.phases).map(([k, v]) => [k, {
        status: v?.status || 'skipped',
        elapsed: v?.elapsed || 0,
        error: v?.error || null,
      }])
    ),
    tasks: session.tasks,
    errors: session.errors,
    spec: session.phases.architect?.spec?.title || null,
    branch: session.phases.implement?.branch || null,
    deployAction: session.phases.deploy?.action || null,
    nightlyTouchAction: session.phases.nightlyTouch?.action || null,
    nightlyTouchFiles: session.phases.nightlyTouch?.files || [],
    metaAction: session.phases.meta?.result?.action || null,
  };

  // Save report
  ensureDir(REPORTS_DIR);
  const reportFile = join(REPORTS_DIR, `${session.date}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');

  // Send WhatsApp summary
  if (sendFn) {
    const phaseLines = Object.entries(report.phases)
      .map(([name, p]) => `  ${name}: ${p.status} (${p.elapsed}s)${p.error ? ' - ' + p.error.slice(0, 80) : ''}`)
      .join('\n');

    const msg = [
      '*FORGE — Overnight Report*',
      `Date: ${session.date}`,
      `Duration: ${session.startedAt} to ${report.finishedAt}`,
      '',
      `Phases:\n${phaseLines}`,
      report.nightlyTouchFiles?.length
        ? `Nightly touch: ${report.nightlyTouchFiles.join(', ')}`
        : '',
      report.spec ? `Spec: ${report.spec}` : '',
      report.branch ? `Branch: ${report.branch}` : '',
      report.deployAction ? `Deploy: ${report.deployAction}` : '',
      report.metaAction ? `Meta: ${report.metaAction}` : '',
      session.errors.length ? `Errors: ${session.errors.length}` : '',
    ].filter(Boolean).join('\n');

    try { await sendFn(msg); } catch { /* non-fatal */ }
  }

  return { reportFile };
}
