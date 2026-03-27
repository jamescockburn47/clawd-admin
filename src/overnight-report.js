// src/overnight-report.js — Collect overnight data, synthesize with Claude, email to James
//
// Runs at 05:30 via scheduler. Collects:
// 1. Dream diary report (from EVO JSON file, or memory service fallback)
// 2. Self-improvement results (from logs)
// 3. Project deep think (from projects.json)
// 4. System health
// 5. Conversation log stats
// Sends full raw data via WhatsApp (multi-message), optionally emails HTML.

import { readFile, readdir } from 'fs/promises';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import config from './config.js';
import logger from './logger.js';
import { getEvoStatus, getMemoryStats, isEvoOnline, searchMemory } from './memory.js';
import { getLatestAnalysis } from './tasks/trace-analyser.js';
import { getLatestRetrospective } from './tasks/weekly-retrospective.js';

const EVO_SSH_HOST = config.evoSshHost;
const EVO_SSH_USER = config.evoSshUser;
import { getSendDocument } from './tools/handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');
const CONV_LOG_DIR = join(DATA_DIR, 'conversation-logs');

const anthropic = config.minimaxEnabled && config.minimaxApiKey
  ? new Anthropic({ apiKey: config.minimaxApiKey, baseURL: config.minimaxBaseUrl })
  : new Anthropic({ apiKey: config.anthropicApiKey });

// --- PDF generation (markdown → HTML → Chromium headless → PDF) ---

async function generatePDF(markdown, dateStr) {
  const { writeFile: writeFileAsync } = await import('fs/promises');
  const { execSync } = await import('child_process');

  // Convert markdown to basic HTML
  const htmlContent = markdownToHTML(markdown, dateStr);
  const htmlPath = `/tmp/clawd-report-${dateStr}.html`;
  const pdfPath = `/tmp/clawd-report-${dateStr}.pdf`;

  await writeFileAsync(htmlPath, htmlContent, 'utf-8');

  try {
    execSync(
      `chromium-browser --headless --disable-gpu --no-sandbox --print-to-pdf="${pdfPath}" "${htmlPath}" 2>/dev/null`,
      { timeout: 30000, stdio: 'pipe' }
    );
    const pdfBuffer = await readFile(pdfPath);
    logger.info({ dateStr, size: pdfBuffer.length }, 'overnight-report: PDF generated');
    return pdfBuffer;
  } catch (err) {
    logger.warn({ err: err.message }, 'overnight-report: Chromium PDF generation failed');
    return null;
  }
}

function markdownToHTML(md, dateStr) {
  // Simple markdown → HTML conversion (no external deps)
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>(?:<br>)?)+/gs, (match) => {
    return '<ul>' + match.replace(/<br>/g, '') + '</ul>';
  });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Clawd Report ${dateStr}</title>
<style>
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; font-size: 14px; line-height: 1.6; }
  h1 { font-size: 22px; border-bottom: 2px solid #333; padding-bottom: 8px; margin-top: 0; }
  h2 { font-size: 17px; color: #333; margin-top: 28px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 14px; color: #555; margin-top: 18px; }
  ul { padding-left: 20px; }
  li { margin-bottom: 4px; }
  blockquote { border-left: 3px solid #ccc; margin: 10px 0; padding: 4px 12px; color: #666; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
  hr { border: none; border-top: 1px solid #ddd; margin: 20px 0; }
  p { margin: 8px 0; }
</style></head><body><p>${html}</p></body></html>`;
}

// --- Data collection ---

// Fetch dream report JSON from EVO (written by dream_mode.py)
async function fetchDreamReportJSON(dateStr) {
  const { execSync } = await import('child_process');
  const localPath = join('/tmp', `overnight-report-${dateStr}.json`);
  const remotePath = `/home/james/clawdbot-logs/overnight-report-${dateStr}.json`;

  // 1. Try rsync from EVO direct ethernet
  try {
    execSync(
      `rsync -az --timeout=10 ${EVO_SSH_USER}@${EVO_SSH_HOST}:${remotePath} ${localPath} 2>/dev/null`,
      { stdio: 'pipe' }
    );
    const data = JSON.parse(await readFile(localPath, 'utf-8'));
    logger.info({ groups: data.groups_processed }, 'overnight-report: dream report loaded via rsync');
    return data;
  } catch (err) {
    logger.warn({ err: err.message }, 'overnight-report: rsync failed, trying scp');
  }

  // 2. Try scp fallback (rsync may not be installed or PATH issue)
  try {
    execSync(
      `scp -o ConnectTimeout=10 ${EVO_SSH_USER}@${EVO_SSH_HOST}:${remotePath} ${localPath} 2>/dev/null`,
      { stdio: 'pipe' }
    );
    const data = JSON.parse(await readFile(localPath, 'utf-8'));
    logger.info({ groups: data.groups_processed }, 'overnight-report: dream report loaded via scp');
    return data;
  } catch (err) {
    logger.warn({ err: err.message }, 'overnight-report: scp also failed');
  }

  // 3. Try WiFi IP fallback (direct ethernet may be down)
  try {
    execSync(
      `scp -o ConnectTimeout=10 james@192.168.1.230:${remotePath} ${localPath} 2>/dev/null`,
      { stdio: 'pipe' }
    );
    const data = JSON.parse(await readFile(localPath, 'utf-8'));
    logger.info({ groups: data.groups_processed }, 'overnight-report: dream report loaded via WiFi scp');
    return data;
  } catch (err) {
    logger.warn({ err: err.message }, 'overnight-report: WiFi scp also failed');
  }

  // 4. Try local file (may have been fetched earlier)
  if (existsSync(localPath)) {
    try {
      return JSON.parse(await readFile(localPath, 'utf-8'));
    } catch {}
  }

  return null;
}

// Fallback: query memory service directly for the date's data
async function fetchFromMemoryService(dateStr) {
  if (!isEvoOnline()) return null;

  const report = {
    date: dateStr,
    groups_processed: 0,
    groups: [],
    totals: { facts: 0, insights: 0, observations: 0 },
    source: 'memory_service',
  };

  try {
    // Fetch diary entries for this date
    const diaryResults = await searchMemory(`diary ${dateStr}`, 'diary', 20);
    const diaries = (diaryResults || [])
      .map(r => r.memory || r)
      .filter(m => m && (m.tags || []).includes(dateStr));

    // Fetch facts extracted on this date
    const factResults = await searchMemory(`diary_extraction ${dateStr}`, 'general', 50);
    const facts = (factResults || [])
      .map(r => r.memory || r)
      .filter(m => m && (m.tags || []).includes(dateStr) && (m.tags || []).includes('diary_extraction'));

    // Fetch insights for this date
    const insightResults = await searchMemory(`diary_insight ${dateStr}`, 'insight', 20);
    const insights = (insightResults || [])
      .map(r => r.memory || r)
      .filter(m => m && (m.tags || []).includes(dateStr));

    // Group diaries by group_id (extracted from tags)
    const groupMap = new Map();
    for (const d of diaries) {
      const groupTag = (d.tags || []).find(t => t.includes('@') || t.includes('_'));
      const groupId = groupTag || 'unknown';
      groupMap.set(groupId, {
        group_id: groupId,
        message_count: 0, // unknown from memory service
        diary: d.fact || '',
        facts: [],
        insights: [],
        observations: [],
      });
    }

    // Assign facts to groups
    for (const f of facts) {
      const groupTag = (f.tags || []).find(t => t.includes('@') || t.includes('_'));
      const groupId = groupTag || 'unknown';
      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, { group_id: groupId, message_count: 0, diary: '', facts: [], insights: [], observations: [] });
      }
      groupMap.get(groupId).facts.push({ fact: f.fact, tags: f.tags, confidence: f.confidence });
    }

    // Assign insights to groups
    for (const ins of insights) {
      const groupTag = (ins.tags || []).find(t => t.includes('@') || t.includes('_'));
      const groupId = groupTag || 'unknown';
      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, { group_id: groupId, message_count: 0, diary: '', facts: [], insights: [], observations: [] });
      }
      groupMap.get(groupId).insights.push({ insight: ins.fact, topics: ins.tags });
    }

    report.groups = Array.from(groupMap.values());
    report.groups_processed = report.groups.length;
    report.totals.facts = facts.length;
    report.totals.insights = insights.length;

    if (report.groups_processed > 0) {
      logger.info({ groups: report.groups_processed, facts: facts.length, insights: insights.length },
        'overnight-report: loaded from memory service');
      return report;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'overnight-report: memory service query failed');
  }

  return null;
}

// Get conversation log stats for the date
function getConversationLogStats(dateStr) {
  const stats = [];
  try {
    if (!existsSync(CONV_LOG_DIR)) return stats;
    const files = readdirSync(CONV_LOG_DIR).filter(f => f.startsWith(dateStr) && f.endsWith('.jsonl'));
    for (const file of files) {
      const groupId = file.replace(`${dateStr}_`, '').replace('.jsonl', '');
      const content = readFileSync(join(CONV_LOG_DIR, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      stats.push({ groupId, messageCount: lines.length });
    }
  } catch {}
  return stats;
}

// Load project deep think results
function loadProjectThinkResults() {
  try {
    const projects = JSON.parse(readFileSync(join(DATA_DIR, 'projects.json'), 'utf-8'));
    return (projects.projects || [])
      .filter(p => p.lastDeepThink)
      .map(p => ({
        name: p.name,
        date: p.lastDeepThink.date,
        models: p.lastDeepThink.models,
        insights: p.lastDeepThink.insightsExtracted,
        summary: p.lastDeepThink.summary || '',
      }));
  } catch {
    return [];
  }
}

// Load last self-improvement results
async function loadSelfImprovementResults() {
  try {
    const reportPath = join(DATA_DIR, 'last-improvement-report.json');
    if (existsSync(reportPath)) {
      return JSON.parse(await readFile(reportPath, 'utf-8'));
    }
  } catch {}
  return null;
}

// --- Email synthesis (Claude) ---

async function synthesizeReport(dreamReport, projectThink, selfImprove, systemHealth, dateStr) {
  const prompt = `You are producing James Cockburn's daily overnight intelligence report — a structured HTML email.

DATE: ${dateStr}

## Dream/Diary Data (from Clawd's overnight diary)
${dreamReport ? JSON.stringify(dreamReport, null, 2) : 'Dream mode did not run or produced no output.'}

## Project Deep Think Results
${projectThink.length > 0 ? JSON.stringify(projectThink, null, 2) : 'No project deep think ran.'}

## Self-Improvement Cycle
${selfImprove ? JSON.stringify(selfImprove, null, 2) : 'No self-improvement data.'}

## System Health
${JSON.stringify(systemHealth, null, 2)}

PRODUCE an HTML email body (just the <body> content, no <html> or <head> tags). Style it inline for email compatibility.

STRUCTURE:
1. **Header**: "Clawd Overnight Report — ${dateStr}" with a clean dark header bar
2. **Diary Summaries**: For each group chat processed, show the FULL diary narrative. Include message counts.
3. **Extracted Facts**: ALL facts from all groups in a clean table — do NOT omit any
4. **Insights**: ALL insights in a highlight box — do NOT omit any
5. **Soul Observations**: Any personality evolution observations, with their severity
6. **Project Deep Think**: Full summary of any overnight project analysis
7. **Self-Improvement**: What was tested, what was applied
8. **System Status**: Memory count, EVO status, queue depth — one line

STYLE: Professional, dark theme (#1a1a2e background, #e0e0e0 text). Use inline CSS only. Compact but readable.

IMPORTANT: Include ALL data. Do not summarise or omit facts/insights. The diary narratives should read as Clawd's first-person reflections.`;

  try {
    const response = await anthropic.messages.create({
      model: config.minimaxEnabled ? config.minimaxModel : config.claudeModel,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0].text;
  } catch (err) {
    logger.error({ err: err.message }, 'overnight-report: Claude synthesis failed');
    return null;
  }
}

// --- Email send ---

async function sendReportEmail(htmlBody, dateStr) {
  if (!config.googleClientId || !config.googleRefreshToken) {
    logger.warn('overnight-report: Gmail not configured, skipping email');
    return false;
  }

  const oauth2 = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
  oauth2.setCredentials({ refresh_token: config.googleRefreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const subject = `Clawd Overnight Report — ${dateStr}`;
  const to = 'james.a.cockburn@gmail.com';
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
  ].join('\r\n');

  const raw = Buffer.from(`${headers}\r\n\r\n${htmlBody}`).toString('base64url');

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    logger.info('overnight-report: email sent');
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'overnight-report: email send failed');
    return false;
  }
}

// --- WhatsApp: full raw data dump (no Claude, no truncation) ---

async function sendWhatsAppFullReport(sendFn, dreamReport, projectThink, selfImprove, systemHealth, logStats, dateStr) {
  const MAX_MSG = 4000;

  // Helper: send a section, splitting if needed
  async function sendSection(text) {
    if (!text || text.trim().length === 0) return;
    if (text.length <= MAX_MSG) {
      await sendFn(text);
      return;
    }
    // Split on double newlines
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_MSG) {
        await sendFn(remaining);
        break;
      }
      const chunk = remaining.slice(0, MAX_MSG);
      const splitAt = chunk.lastIndexOf('\n\n');
      const cutAt = splitAt > MAX_MSG * 0.3 ? splitAt : chunk.lastIndexOf('\n');
      const finalCut = cutAt > MAX_MSG * 0.3 ? cutAt : MAX_MSG;
      await sendFn(remaining.slice(0, finalCut));
      remaining = remaining.slice(finalCut).trim();
    }
  }

  // --- Header ---
  let header = `*CLAWD OVERNIGHT REPORT*\n${dateStr}\n`;
  if (logStats.length > 0) {
    const totalMsgs = logStats.reduce((sum, s) => sum + s.messageCount, 0);
    header += `${logStats.length} chats logged, ${totalMsgs} messages total\n`;
  }
  if (dreamReport) {
    header += `${dreamReport.groups_processed} groups dreamed | ${dreamReport.totals?.facts || 0} facts | ${dreamReport.totals?.insights || 0} insights | ${dreamReport.totals?.observations || 0} observations`;
    if (dreamReport.source === 'memory_service') header += ' (from memory service)';
  } else {
    header += 'Dream data: unavailable';
  }
  await sendSection(header);

  // --- Conversation log stats ---
  if (logStats.length > 0) {
    let logSection = '*CONVERSATION LOGS*\n';
    for (const s of logStats) {
      logSection += `${s.groupId.slice(0, 12)}... — ${s.messageCount} msgs\n`;
    }
    await sendSection(logSection);
  }

  // --- Diary entries (full, no truncation) ---
  if (dreamReport?.groups?.length > 0) {
    for (const g of dreamReport.groups) {
      const groupLabel = g.group_id.includes('_lid') ? 'DM' : `Group ${g.group_id.slice(0, 12)}...`;
      let diarySection = `*DIARY: ${groupLabel}*`;
      if (g.message_count > 0) diarySection += ` (${g.message_count} msgs)`;
      diarySection += '\n';
      diarySection += g.diary || '(no diary generated)';
      if (g.warnings?.length > 0) {
        diarySection += `\n_Validation: ${g.warnings.join(', ')}_`;
      }
      await sendSection(diarySection);
    }
  }

  // --- All facts (full, no truncation) ---
  if (dreamReport?.groups?.length > 0) {
    const allFacts = dreamReport.groups.flatMap(g =>
      (g.facts || []).map(f => typeof f === 'string' ? f : f.fact)
    );
    if (allFacts.length > 0) {
      let factSection = `*FACTS EXTRACTED (${allFacts.length})*\n`;
      factSection += allFacts.map((f, i) => `${i + 1}. ${f}`).join('\n');
      await sendSection(factSection);
    }
  }

  // --- All insights (full) ---
  if (dreamReport?.groups?.length > 0) {
    const allInsights = dreamReport.groups.flatMap(g =>
      (g.insights || []).map(i => typeof i === 'string' ? i : (i.insight || i.fact))
    );
    if (allInsights.length > 0) {
      let insightSection = `*INSIGHTS (${allInsights.length})*\n`;
      insightSection += allInsights.map((ins, i) => `${i + 1}. ${ins}`).join('\n');
      await sendSection(insightSection);
    }
  }

  // --- Soul observations (full) ---
  if (dreamReport?.groups?.length > 0) {
    const allObs = dreamReport.groups.flatMap(g =>
      (g.observations || []).map(o => `[${o.severity}] ${o.text}`)
    );
    if (allObs.length > 0) {
      let obsSection = `*SOUL OBSERVATIONS (${allObs.length})*\n`;
      obsSection += allObs.map(o => `- ${o}`).join('\n');
      await sendSection(obsSection);
    }
  }

  // --- Project deep think (full summaries) ---
  if (projectThink.length > 0) {
    for (const p of projectThink) {
      let thinkSection = `*DEEP THINK: ${p.name}*\n`;
      if (p.date) thinkSection += `Date: ${p.date}\n`;
      if (p.models?.length) thinkSection += `Models: ${p.models.join(', ')}\n`;
      if (p.insights?.length) {
        thinkSection += `Insights:\n${p.insights.map(ins => `- ${ins}`).join('\n')}\n`;
      }
      if (p.summary) {
        thinkSection += `\n${p.summary}`;
      }
      await sendSection(thinkSection);
    }
  }

  // --- Self-improvement ---
  if (selfImprove) {
    let siSection = '*SELF-IMPROVEMENT*\n';
    siSection += JSON.stringify(selfImprove, null, 2);
    await sendSection(siSection);
  }

  // --- System health ---
  await sendSection(`*SYSTEM:* EVO ${systemHealth.evo} | ${systemHealth.memories} memories | Queue: ${systemHealth.queueDepth}`);
}

// --- Main entry point ---

// --- Generate structured markdown report ---

function generateMarkdownReport(dreamReport, projectThink, selfImprove, systemHealth, logStats, dateStr, traceAnalysis = null, retrospective = null) {
  const lines = [];
  const dayName = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  lines.push(`# Clawd Overnight Report`);
  lines.push(`**${dayName}**\n`);

  // Summary line
  if (logStats.length > 0) {
    const totalMsgs = logStats.reduce((sum, s) => sum + s.messageCount, 0);
    lines.push(`${logStats.length} chats logged, ${totalMsgs} messages total.`);
  }
  if (dreamReport) {
    lines.push(`${dreamReport.groups_processed} groups dreamed | ${dreamReport.totals?.facts || 0} facts | ${dreamReport.totals?.insights || 0} insights | ${dreamReport.totals?.observations || 0} observations`);
    if (dreamReport.source === 'memory_service') lines.push('*(from memory service fallback)*');
  } else {
    lines.push('Dream data: unavailable.');
  }
  lines.push('');

  // System health
  lines.push(`## System`);
  lines.push(`- EVO: ${systemHealth.evo}`);
  lines.push(`- Memories: ${systemHealth.memories}`);
  lines.push(`- Queue depth: ${systemHealth.queueDepth}`);
  lines.push('');

  // Conversation log stats
  if (logStats.length > 0) {
    lines.push(`## Conversation Logs`);
    for (const s of logStats) {
      lines.push(`- \`${s.groupId.slice(0, 15)}...\` — ${s.messageCount} messages`);
    }
    lines.push('');
  }

  // Diary entries
  if (dreamReport?.groups?.length > 0) {
    lines.push(`## Diary Entries`);
    for (const g of dreamReport.groups) {
      const label = g.group_id.includes('_lid') ? 'DM' : `Group ${g.group_id.slice(0, 15)}...`;
      lines.push(`### ${label}`);
      if (g.message_count > 0) lines.push(`*${g.message_count} messages*\n`);
      lines.push(g.diary || '*(no diary generated)*');
      if (g.warnings?.length > 0) {
        lines.push(`\n> Validation: ${g.warnings.join(', ')}`);
      }
      lines.push('');
    }
  }

  // Facts
  if (dreamReport?.groups?.length > 0) {
    const allFacts = dreamReport.groups.flatMap(g =>
      (g.facts || []).map(f => typeof f === 'string' ? f : f.fact)
    );
    if (allFacts.length > 0) {
      lines.push(`## Facts Extracted (${allFacts.length})`);
      allFacts.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
      lines.push('');
    }
  }

  // Insights
  if (dreamReport?.groups?.length > 0) {
    const allInsights = dreamReport.groups.flatMap(g =>
      (g.insights || []).map(i => typeof i === 'string' ? i : (i.insight || i.fact))
    );
    if (allInsights.length > 0) {
      lines.push(`## Insights (${allInsights.length})`);
      allInsights.forEach((ins, i) => lines.push(`${i + 1}. ${ins}`));
      lines.push('');
    }
  }

  // Verbatim excerpts
  if (dreamReport?.groups?.length > 0) {
    const allVerbatim = dreamReport.groups.flatMap(g =>
      (g.verbatim || []).map(v => `**${v.speaker}**: "${v.quote}"${v.context ? ` — *${v.context}*` : ''}`)
    );
    if (allVerbatim.length > 0) {
      lines.push(`## Verbatim Excerpts`);
      allVerbatim.forEach(v => lines.push(`- ${v}`));
      lines.push('');
    }
  }

  // Soul observations
  if (dreamReport?.groups?.length > 0) {
    const allObs = dreamReport.groups.flatMap(g =>
      (g.observations || []).map(o => `[${o.severity}] ${o.text}`)
    );
    if (allObs.length > 0) {
      lines.push(`## Soul Observations (${allObs.length})`);
      allObs.forEach(o => lines.push(`- ${o}`));
      lines.push('');
    }
  }

  // Project deep think
  if (projectThink.length > 0) {
    lines.push(`## Project Deep Think`);
    for (const p of projectThink) {
      lines.push(`### ${p.name}`);
      if (p.date) lines.push(`*${p.date}*\n`);
      if (p.models?.length) lines.push(`Models: ${p.models.join(', ')}\n`);
      if (p.insights?.length) {
        lines.push('Insights:');
        p.insights.forEach(ins => lines.push(`- ${ins}`));
      }
      if (p.summary) lines.push(`\n${p.summary}`);
      lines.push('');
    }
  }

  // Self-improvement
  if (selfImprove) {
    lines.push(`## Self-Improvement`);
    if (typeof selfImprove === 'object') {
      for (const [k, v] of Object.entries(selfImprove)) {
        lines.push(`- **${k}**: ${JSON.stringify(v)}`);
      }
    } else {
      lines.push(String(selfImprove));
    }
    lines.push('');
  }

  // Trace analysis (Phase 2)
  if (traceAnalysis) {
    lines.push(`## Reasoning Trace Analysis`);
    lines.push(`${traceAnalysis.totalTraces} traces analysed (${traceAnalysis.periodDays}d)\n`);

    // Routing
    const rp = traceAnalysis.routing?.percentages || {};
    lines.push(`**Routing:** keywords ${rp.keywords || 0}%, 4B ${rp['4b_classifier'] || 0}%, fallback ${rp.fallback || 0}%`);

    // Categories
    const cats = Object.entries(traceAnalysis.categories || {}).slice(0, 5);
    if (cats.length > 0) {
      lines.push(`**Top categories:** ${cats.map(([k, v]) => `${k} (${v})`).join(', ')}`);
    }

    // Plans
    if (traceAnalysis.plans?.totalPlans > 0) {
      const p = traceAnalysis.plans;
      lines.push(`**Plans:** ${p.totalPlans} executed, avg ${p.avgSteps} steps, avg ${p.avgTimeMs}ms`);
      lines.push(`  Statuses: ${Object.entries(p.statuses).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    }

    // needsPlan accuracy
    const np = traceAnalysis.needsPlan;
    if (np && (np.predictedTrue + np.predictedFalse > 0)) {
      lines.push(`**needsPlan accuracy:** precision ${np.precision}%, recall ${np.recall}%, F1 ${np.f1}%`);
    }

    // Timing
    const t = traceAnalysis.timing;
    if (t?.routingAvgMs) {
      lines.push(`**Timing:** routing avg ${t.routingAvgMs}ms p95 ${t.routingP95Ms}ms | total avg ${t.totalAvgMs}ms p95 ${t.totalP95Ms}ms`);
    }

    // Anomalies
    if (traceAnalysis.anomalies?.length > 0) {
      lines.push('\n**Anomalies:**');
      for (const a of traceAnalysis.anomalies) {
        lines.push(`- [${a.severity}] ${a.detail}`);
        if (a.suggestion) lines.push(`  *${a.suggestion}*`);
      }
    }
    lines.push('');
  }

  // Weekly retrospective (if available and recent)
  if (retrospective) {
    lines.push(`## Weekly Retrospective`);
    lines.push(`Health: **${retrospective.overallHealth}** — ${retrospective.healthReason}\n`);

    if (retrospective.priorities?.length > 0) {
      lines.push('**Improvement priorities:**');
      for (const p of retrospective.priorities) {
        lines.push(`${p.rank}. [${p.severity}] **${p.title}**`);
        lines.push(`   ${p.issue}`);
        lines.push(`   Fix: ${p.fix}`);
      }
    }

    if (retrospective.evolutionTasksCreated?.length > 0) {
      lines.push(`\n**Evolution tasks queued:** ${retrospective.evolutionTasksCreated.length}`);
      for (const t of retrospective.evolutionTasksCreated) {
        lines.push(`- ${t.title} (${t.taskId})`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated ${new Date().toISOString()}*`);

  return lines.join('\n');
}

export async function sendOvernightReport(sendFn, dateOverride = null) {
  let dateStr;
  if (dateOverride) {
    dateStr = dateOverride;
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    dateStr = yesterday.toISOString().split('T')[0];
  }

  logger.info({ date: dateStr }, 'overnight-report: generating');

  // 1. Fetch dream report — try JSON file first, fall back to memory service
  let dreamReport = await fetchDreamReportJSON(dateStr);
  if (!dreamReport) {
    logger.info('overnight-report: JSON file unavailable, querying memory service');
    dreamReport = await fetchFromMemoryService(dateStr);
  }

  // 2. Conversation log stats
  const logStats = getConversationLogStats(dateStr);

  // 3. Enrich dream report with log stats (message counts) if we got them
  if (dreamReport && logStats.length > 0) {
    for (const g of dreamReport.groups) {
      const stat = logStats.find(s => g.group_id.includes(s.groupId) || s.groupId.includes(g.group_id));
      if (stat && g.message_count === 0) {
        g.message_count = stat.messageCount;
      }
    }
  }

  // 4. Load project deep think
  const projectThink = loadProjectThinkResults();

  // 5. Load self-improvement
  const selfImprove = await loadSelfImprovementResults();

  // 6. System health
  const evo = getEvoStatus();
  let memoryStats = {};
  try {
    memoryStats = isEvoOnline() ? await getMemoryStats() : {};
  } catch {}

  const systemHealth = {
    evo: evo.online ? 'online' : 'offline',
    queueDepth: evo.queueDepth || 0,
    memories: memoryStats.total || 'unknown',
  };

  // 7. Load trace analysis and retrospective (Phase 2)
  const traceAnalysis = getLatestAnalysis();
  const retrospective = getLatestRetrospective();

  // 8. Generate report and send as document attachments
  const markdown = generateMarkdownReport(dreamReport, projectThink, selfImprove, systemHealth, logStats, dateStr, traceAnalysis, retrospective);
  const docSender = getSendDocument();

  if (docSender) {
    const totalFacts = dreamReport?.totals?.facts || 0;
    const totalInsights = dreamReport?.totals?.insights || 0;
    const caption = `Overnight report for ${dateStr} — ${dreamReport?.groups_processed || 0} groups, ${totalFacts} facts, ${totalInsights} insights`;

    try {
      // Send as .txt (universally readable on phones)
      const txtBuffer = Buffer.from(markdown, 'utf-8');
      await docSender(txtBuffer, `clawd-report-${dateStr}.txt`, 'text/plain', caption);
      logger.info({ dateStr, size: txtBuffer.length }, 'overnight-report: txt document sent');
    } catch (err) {
      logger.warn({ err: err.message }, 'overnight-report: txt send failed');
    }

    try {
      // Send as PDF (via markdown-to-HTML-to-PDF on Pi)
      const pdfBuffer = await generatePDF(markdown, dateStr);
      if (pdfBuffer) {
        await docSender(pdfBuffer, `clawd-report-${dateStr}.pdf`, 'application/pdf', caption);
        logger.info({ dateStr, size: pdfBuffer.length }, 'overnight-report: pdf document sent');
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'overnight-report: pdf generation/send failed');
    }
  } else if (sendFn) {
    // No document sender available — use chunked text
    await sendWhatsAppFullReport(sendFn, dreamReport, projectThink, selfImprove, systemHealth, logStats, dateStr);
  }

  // 9. Try email (HTML via Claude synthesis)
  let emailSent = false;
  if (config.googleClientId && config.googleRefreshToken) {
    const htmlBody = await synthesizeReport(dreamReport, projectThink, selfImprove, systemHealth, dateStr);
    if (htmlBody) {
      try {
        const { writeFile: writeFileAsync } = await import('fs/promises');
        await writeFileAsync(`/tmp/clawd-report-${dateStr}.html`,
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clawd Report ${dateStr}</title></head><body>${htmlBody}</body></html>`);
      } catch {}
      emailSent = await sendReportEmail(htmlBody, dateStr);
    }
  }

  return emailSent;
}
