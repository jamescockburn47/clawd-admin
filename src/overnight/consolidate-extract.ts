// src/overnight/consolidate-extract.ts — drives yesterday's conversation logs
// through the EVO memory service /extract endpoint and collects candidates.
// Spec §4.1 consolidate stage, inputs.
//
// Dependency-injected EVO client so tests can mock without esmock.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryCandidate } from './consolidate-validate.js';

/** Minimum assembled-conversation length before we bother calling EVO. */
export const MIN_CONVERSATION_CHARS = 50;
/** Minimum number of log lines in a file before we process it. */
export const MIN_LOG_LINES = 2;

export interface ExtractClient {
  /**
   * Call EVO's memory service /extract endpoint with `store_results: false`.
   * Returns the candidate list without persisting anything.
   */
  extractCandidates(
    conversation: string,
    source: string,
  ): Promise<{ candidates: unknown[] }>;
}

export interface ConsolidateExtractorOptions {
  client: ExtractClient;
  logDir: string;
}

export interface ExtractError {
  file: string;
  reason: string;
}

export interface ExtractResult {
  filesProcessed: number;
  candidates: MemoryCandidate[];
  errors: ExtractError[];
}

interface LogMessage {
  sender?: string;
  text?: string;
  isBot?: boolean;
}

export class ConsolidateExtractor {
  constructor(private readonly opts: ConsolidateExtractorOptions) {}

  /**
   * Extract candidates from all log files whose name begins with the given date.
   * Files that can't be parsed or whose content is trivially short are skipped
   * and counted in `errors` (for parse failures) or silently ignored (for
   * too-short conversations).
   */
  async extractForDate(date: string): Promise<ExtractResult> {
    const result: ExtractResult = { filesProcessed: 0, candidates: [], errors: [] };
    if (!existsSync(this.opts.logDir)) return result;

    const all = await readdir(this.opts.logDir);
    const matching = all.filter((f) => f.startsWith(date) && f.endsWith('.jsonl'));

    for (const file of matching) {
      try {
        const content = await readFile(join(this.opts.logDir, file), 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        if (lines.length < MIN_LOG_LINES) continue;

        const messages = this.parseLines(lines, file);
        if (messages.length < MIN_LOG_LINES) continue;

        const convText = this.renderConversation(messages);
        if (convText.length < MIN_CONVERSATION_CHARS) continue;

        const source = `conversation_${date}_${file.replace(/\.jsonl$/, '')}`;
        try {
          const { candidates } = await this.opts.client.extractCandidates(convText, source);
          for (const c of candidates) {
            result.candidates.push(c as MemoryCandidate);
          }
          result.filesProcessed += 1;
        } catch (err) {
          result.errors.push({ file, reason: (err as Error).message });
        }
      } catch (err) {
        result.errors.push({ file, reason: (err as Error).message });
      }
    }

    return result;
  }

  private parseLines(lines: string[], file: string): LogMessage[] {
    const messages: LogMessage[] = [];
    let parseFailed = false;
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as LogMessage);
      } catch {
        parseFailed = true;
      }
    }
    // If every single line failed to parse, treat the file as unreadable.
    if (parseFailed && messages.length === 0) {
      throw new Error(`every line in ${file} failed to parse as JSON`);
    }
    return messages;
  }

  private renderConversation(messages: LogMessage[]): string {
    return messages
      .map((m) => {
        const name = m.sender ?? (m.isBot ? 'Clint' : 'User');
        return `${name}: ${m.text ?? ''}`;
      })
      .join('\n');
  }
}
