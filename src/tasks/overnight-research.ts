import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { appendEvent } from '../overnight/events.js';

const RESEARCH_HOUR = 3;
const RESEARCH_MINUTE = 45;
const MAX_TOPICS = 3;
const MAX_TRANSCRIPT_LINES = 80;
const MAX_FETCHED_PAGES = 3;
const URL_PATTERN = /^   (https?:\/\/\S+)/gm;

export interface ResearchTopicReport {
  topic: string;
  findings: string;
  sources: string[];
}

export interface OvernightResearchReport {
  date: string;
  source: 'searxng';
  topics: ResearchTopicReport[];
}

type SearchFn = (input: { query: string; count?: number }) => Promise<string>;
type FetchFn = (input: { url: string }) => Promise<string>;
type ChatFn = (system: string, user: string, maxTokens?: number) => Promise<string | null>;
type ChooseTopicsFn = (transcript: string) => Promise<string[]>;

export interface RunOvernightResearchOptions {
  date: string;
  logDir?: string;
  overnightDir?: string;
  search?: SearchFn;
  fetchPage?: FetchFn;
  chat?: ChatFn;
  chooseTopics?: ChooseTopicsFn;
}

let lastResearchDate: string | null = null;

async function importJsModule(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

async function defaultSearch(input: { query: string; count?: number }): Promise<string> {
  const mod = await importJsModule('../tools/search.js');
  return (mod.webSearch as SearchFn)(input);
}

async function defaultFetch(input: { url: string }): Promise<string> {
  const mod = await importJsModule('../tools/search.js');
  return (mod.webFetch as FetchFn)(input);
}

async function defaultChat(system: string, user: string, maxTokens?: number): Promise<string | null> {
  const mod = await importJsModule('../evo-llm.js');
  return (mod.evoSimpleChat as ChatFn)(system, user, maxTokens);
}

async function logResearchFailure(err: Error): Promise<void> {
  const mod = await importJsModule('../logger.js');
  const logger = mod.default as { error(fields: { err: string }, message: string): void };
  logger.error({ err: err.message }, 'overnight research failed');
}

function previousDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function loadTranscript(date: string, logDir = join('data', 'conversation-logs')): Promise<string> {
  const dates = new Set([date, previousDate(date)]);
  let files: string[] = [];
  try {
    files = await readdir(logDir);
  } catch {
    // intentional: no conversation-log directory means there is nothing to research.
    return '';
  }

  const lines: string[] = [];
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    if (!dates.has(file.slice(0, 10))) continue;
    const raw = await readFile(join(logDir, file), 'utf8').catch(() => {
      // intentional: skip unreadable rotated/partial conversation logs
      return '';
    });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { sender?: string; text?: string; isBot?: boolean };
        if (entry.isBot || !entry.text || entry.text.length < 20) continue;
        lines.push(`${entry.sender ?? 'unknown'}: ${entry.text}`);
      } catch {
        // intentional: skip malformed conversation log lines
      }
    }
  }

  return lines.slice(-MAX_TRANSCRIPT_LINES).join('\n');
}

function parseTopicList(raw: string | null): string[] {
  if (!raw) return [];
  const firstBracket = raw.indexOf('[');
  const lastBracket = raw.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(firstBracket, lastBracket + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((topic): topic is string => typeof topic === 'string')
      .map((topic) => topic.trim())
      .filter(Boolean)
      .slice(0, MAX_TOPICS);
  } catch {
    return [];
  }
}

function fallbackTopics(transcript: string): string[] {
  const candidates = transcript
    .split('\n')
    .map((line) => line.replace(/^[^:]+:\s*/, '').trim())
    .filter((line) => line.length > 40)
    .filter((line) => /\b(research|check|find|how|what|why|latest|current|better|free|browser|web)\b/i.test(line));
  return [...new Set(candidates)].slice(0, MAX_TOPICS);
}

async function chooseTopics(transcript: string, chat: ChatFn): Promise<string[]> {
  const system = 'Select up to 3 overnight web research topics from the transcript. Output only a JSON array of short topic strings. Prefer topics James appears to care about and that benefit from current web research.';
  const user = `Transcript:\n${transcript.slice(-12000)}`;
  const raw = await chat(system, user, 300).catch(() => null);
  const parsed = parseTopicList(raw);
  return parsed.length > 0 ? parsed : fallbackTopics(transcript);
}

function extractSources(searchText: string): string[] {
  const urls = new Set<string>();
  for (const match of searchText.matchAll(URL_PATTERN)) {
    urls.add(match[1]!);
  }
  return [...urls].slice(0, MAX_FETCHED_PAGES);
}

async function researchTopic(
  topic: string,
  search: SearchFn,
  fetchPage: FetchFn,
  chat: ChatFn,
): Promise<ResearchTopicReport> {
  const searchText = await search({ query: topic, count: 6 });
  const sources = extractSources(searchText);
  const fetched = await Promise.all(
    sources.map(async (url) => `URL: ${url}\n${await fetchPage({ url })}`),
  );
  const system = 'Create a concise overnight research briefing with specific findings. Use only the supplied search results and fetched page text. Mention uncertainty. No hype.';
  const user = `Topic: ${topic}\n\nSearch results:\n${searchText}\n\nFetched pages:\n${fetched.join('\n\n---\n\n')}`;
  const findings = await chat(system, user, 700).catch(() => null);
  return {
    topic,
    findings: findings?.trim() || searchText,
    sources,
  };
}

export async function runOvernightResearch(
  opts: RunOvernightResearchOptions,
): Promise<OvernightResearchReport> {
  const overnightDir = opts.overnightDir ?? join('data', 'overnight');
  const transcript = await loadTranscript(opts.date, opts.logDir);
  const report: OvernightResearchReport = { date: opts.date, source: 'searxng', topics: [] };

  if (!transcript.trim()) {
    await appendEvent({
      stage: 'operations',
      phase: 'overnight-research',
      inputs: [],
      outputs: [],
      verdict: 'skipped',
      reason: 'no conversation text available for overnight research',
      evidence_refs: [],
      rollback_ref: null,
      budget: { opus_sessions: 0, tokens: 0 },
    }, { date: opts.date, overnightDir });
    return report;
  }

  const chat = opts.chat ?? defaultChat;
  const topics = opts.chooseTopics
    ? await opts.chooseTopics(transcript)
    : await chooseTopics(transcript, chat);
  const selectedTopics = topics.slice(0, MAX_TOPICS);
  const search = opts.search ?? defaultSearch;
  const fetchPage = opts.fetchPage ?? defaultFetch;

  report.topics = await Promise.all(
    selectedTopics.map((topic) => researchTopic(topic, search, fetchPage, chat)),
  );

  await mkdir(overnightDir, { recursive: true });
  await writeFile(
    join(overnightDir, `research-${opts.date}.json`),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  await appendEvent({
    stage: 'operations',
    phase: 'overnight-research',
    inputs: [`transcript_lines:${transcript.split('\n').length}`],
    outputs: [
      ...report.topics.map((topic) => `research:${topic.topic}`),
      ...report.topics.flatMap((topic) => topic.sources.slice(0, 2).map((source) => `source:${source}`)),
    ],
    verdict: report.topics.length > 0 ? 'ok' : 'skipped',
    reason: report.topics.length > 0
      ? `researched ${report.topics.length} topic${report.topics.length === 1 ? '' : 's'} using SearXNG`
      : 'no research topics selected',
    evidence_refs: [],
    rollback_ref: null,
    budget: { opus_sessions: 0, tokens: 0 },
  }, { date: opts.date, overnightDir });

  return report;
}

export async function checkOvernightResearch(
  todayStr: string,
  hours: number,
  minutes: number,
): Promise<void> {
  if (lastResearchDate === todayStr) return;
  if (hours !== RESEARCH_HOUR || minutes !== RESEARCH_MINUTE) return;
  lastResearchDate = todayStr;
  try {
    await runOvernightResearch({ date: todayStr });
  } catch (err) {
    await logResearchFailure(err as Error);
    throw err;
  }
}
