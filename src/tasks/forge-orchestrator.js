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
  architect: 30 * 60 * 1000,
  implement: 2 * 60 * 60 * 1000,
  review: 30 * 60 * 1000,
  meta: 60 * 60 * 1000,
};

const HARD_STOP_HOUR = 5;
const HARD_STOP_MINUTE = 15;
const SSH_KEY = '/home/pi/.ssh/id_ed25519';
const EVO_USER = 'james';
const EVO_HOST = '10.0.0.2';
const EVO_REPO = '/home/james/clawdbot-claude-code';

let lastForgeDate = null;

// --- Exports ---

export async function checkForge(sendFn, todayStr, hours, minutes) {
  if (lastForgeDate === todayStr) return;
  if (hours !== 22 || minutes < 30) return;

  lastForgeDate = todayStr;
  logger.info('forge: starting overnight session');

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

    // Phase 2: Architect
    if (isBeforeHardStop() && session.phases.analysis?.brief) {
      session.phases.architect = await runPhase('architect', () => phaseArchitect(session));
    }

    // Phase 3: Implement + Test
    if (isBeforeHardStop() && session.phases.architect?.spec) {
      session.phases.implement = await runPhase('implement', () => phaseImplement(session));
    }

    // Phase 4: Review
    if (isBeforeHardStop() && session.phases.implement?.branch) {
      session.phases.review = await runPhase('review', () => phaseReview(session));
    }

    // Phase 5: Deploy or Queue
    if (isBeforeHardStop() && session.phases.review?.verdict) {
      session.phases.deploy = await runPhase('deploy', () => phaseDeploy(session, sendFn));
    }

    // Phase 6: Meta-Improvement
    if (isBeforeHardStop()) {
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

// --- Time guard ---

function isBeforeHardStop() {
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
  // Between 22:30 and 05:15 next day: hours >= 22 OR hours < 5 OR (hours === 5 && minutes < 15)
  if (h >= 22 || h < HARD_STOP_HOUR) return true;
  if (h === HARD_STOP_HOUR && m < HARD_STOP_MINUTE) return true;
  return false;
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

// --- SSH helper ---

async function sshExec(command, timeoutMs = 60000) {
  const args = [
    '-i', SSH_KEY,
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=no',
    `${EVO_USER}@${EVO_HOST}`,
    command,
  ];
  const { stdout, stderr } = await execAsync('ssh', args, { timeout: timeoutMs });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function sshClaudeCode(promptContent, timeoutMs = PHASE_TIMEOUT.implement) {
  // Write prompt to EVO via SSH heredoc
  const escaped = promptContent.replace(/'/g, "'\\''");
  await sshExec(`cat > /tmp/forge-prompt.md << 'FORGE_EOF'\n${escaped}\nFORGE_EOF`, 30000);

  // Run Claude Code CLI
  const cmd = `cd ${EVO_REPO} && ~/.local/bin/claude -p --model claude-opus-4-6 --allowedTools "Edit,Write,Read,Bash,Glob,Grep" < /tmp/forge-prompt.md`;
  const result = await sshExec(cmd, timeoutMs);
  return result.stdout;
}

// --- EVO 30B helper ---

async function queryEvo30B(systemPrompt, userPrompt, maxTokens = 4000) {
  const resp = await llamaBreaker.exec(async () => {
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
  });
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

  // Gather inputs
  const traceAnalysis = readOptional(join('data', 'trace-analysis.json'));
  const learnedRules = readOptional(join('data', 'learned-rules.json'));

  // Recent conversation logs (last 24h summary)
  let logSummary = '';
  const logsDir = join('data', 'conversation-logs');
  if (existsSync(logsDir)) {
    const files = readdirSync(logsDir).filter(f => f.endsWith('.jsonl')).sort().slice(-3);
    const lineCount = files.reduce((sum, f) => {
      try { return sum + readFileSync(join(logsDir, f), 'utf-8').split('\n').filter(Boolean).length; } catch { return sum; }
    }, 0);
    logSummary = `Recent conversation log files: ${files.join(', ')} (${lineCount} total messages)`;
  }

  // Previous forge reports
  let prevReports = '';
  ensureDir(REPORTS_DIR);
  const reportFiles = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json')).sort().slice(-3);
  if (reportFiles.length) {
    prevReports = reportFiles.map(f => {
      const data = readOptional(join(REPORTS_DIR, f));
      if (!data) return '';
      try { const r = JSON.parse(data); return `${f}: tasks=${r.tasks?.length || 0}, phases=${Object.keys(r.phases || {}).join(',')}`; } catch { return f; }
    }).join('\n');
  }

  // Skill metrics
  let skillInfo = '';
  try {
    const skills = await loadSkills();
    skillInfo = skills.map(s => `${s.name} v${s.version || '?'}: triggered=${s.metrics?.timesTriggered || 0}`).join('\n');
  } catch { /* non-fatal */ }

  const userPrompt = [
    '## Trace Analysis', traceAnalysis || 'No trace analysis available.',
    '## Learned Rules', learnedRules || 'No learned rules.',
    '## Conversation Activity', logSummary || 'No recent logs.',
    '## Previous Forge Reports', prevReports || 'No previous reports.',
    '## Skill Metrics', skillInfo || 'No skills loaded.',
  ].join('\n\n');

  const brief = await queryEvo30B(systemPrompt, userPrompt);
  return { brief };
}

// --- Phase 2: Architect ---

async function phaseArchitect(session) {
  const architectPrompt = readPrompt('architect.md');
  const brief = session.phases.analysis.brief;

  const prompt = `${architectPrompt}\n\n## Tonight's Brief\n\n${brief}\n\n## Instructions\n\nProduce a detailed spec for the #1 ranked opportunity. Output JSON with fields: title, description, files_to_modify, approach, tests, auto_deployable (boolean), risks.`;

  const output = await sshClaudeCode(prompt, PHASE_TIMEOUT.architect);

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
  await sshExec(`cd ${EVO_REPO} && git checkout main && git pull && git checkout -b ${branch}`, 30000);

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

  const output = await sshClaudeCode(prompt, PHASE_TIMEOUT.implement);

  // Get diff info
  const { stdout: diffStat } = await sshExec(`cd ${EVO_REPO} && git diff main --stat`, 15000);
  const { stdout: diffFull } = await sshExec(`cd ${EVO_REPO} && git diff main`, 30000);
  const { stdout: filesChanged } = await sshExec(`cd ${EVO_REPO} && git diff main --name-only`, 15000);

  return {
    branch,
    diffStat,
    diff: diffFull.slice(0, 10000),
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
    '```',
    impl.diff || 'No diff available',
    '```',
    '',
    '## Files Changed',
    (impl.files || []).join(', '),
    '',
    '## Instructions',
    'Review this diff against the spec. Output JSON with: verdict ("auto-deploy" or "needs-approval"), test_pass (boolean), eval_regression (boolean), issues (array of strings), summary (string).',
  ].join('\n');

  const output = await sshClaudeCode(prompt, PHASE_TIMEOUT.review);

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

async function phaseDeploy(session, sendFn) {
  const review = session.phases.review.verdict;
  const impl = session.phases.implement;
  const spec = session.phases.architect?.spec;
  const branch = impl.branch;

  const canAutoDeploy =
    review.verdict === 'auto-deploy' &&
    review.test_pass === true &&
    review.eval_regression !== true &&
    spec?.auto_deployable === true;

  if (canAutoDeploy) {
    try {
      // Merge on EVO
      await sshExec(`cd ${EVO_REPO} && git checkout main && git merge --no-ff ${branch}`, 30000);

      // Copy skills from EVO to Pi
      try {
        await execAsync('scp', [
          '-i', SSH_KEY, '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no',
          '-r', `${EVO_USER}@${EVO_HOST}:${EVO_REPO}/src/skills/`, 'src/skills/',
        ], { timeout: 30000 });
      } catch (scpErr) {
        logger.warn({ err: scpErr.message }, 'forge: scp skills failed (non-fatal)');
      }

      // Reload skills
      await loadSkills();

      return { action: 'auto-deployed', branch, files: impl.files };
    } catch (deployErr) {
      // Revert on failure
      logger.error({ err: deployErr.message }, 'forge: auto-deploy failed, reverting');
      try {
        await sshExec(`cd ${EVO_REPO} && git revert --no-commit HEAD && git commit -m "revert: forge auto-deploy failed"`, 30000);
      } catch { /* best effort */ }
      return { action: 'deploy-failed', error: deployErr.message, branch };
    }
  }

  // Queue for approval
  const task = createTask(
    `Forge: ${spec?.title || 'overnight improvement'} — ${review.summary || 'see spec'}`,
    'forge',
    'normal',
  );
  session.tasks.push(task?.id);

  if (sendFn && config.ownerJid) {
    const msg = [
      '*FORGE — Overnight Result*',
      `Branch: ${branch}`,
      `Files: ${(impl.files || []).join(', ')}`,
      `Verdict: ${review.verdict}`,
      review.summary || '',
      '',
      `Task ${task?.id} queued for approval.`,
    ].join('\n');
    try { await sendFn(msg); } catch { /* non-fatal */ }
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

  const output = await sshClaudeCode(prompt, PHASE_TIMEOUT.meta);

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
