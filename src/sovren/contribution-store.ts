/// <reference types="node" />
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ContributionEntry,
  ContributionIndex,
  ContributionKind,
  ContributionStatus,
  MethodologyContribution,
  XlsxStructure,
  DocumentExcerpt,
  BurstMessage,
} from './types.js';
import { renderMethodologyMarkdown } from './methodology-render.js';

/**
 * Single writer for the SOVREN methodology contribution store. Owns the
 * directory layout, the index file, and concurrency.
 *
 * Layout (per spec §6.3):
 *
 *   <root>/
 *     index.json
 *     <contributor-slug>/
 *       <YYYY-MM-DD>-<slug>/
 *         source.xlsx              (if applicable)
 *         source.<ext>             (other doc types)
 *         xlsx-structure.json      (if xlsx)
 *         document-excerpt.json    (if pdf/docx/text)
 *         burst-messages.json      (if a multi-message burst)
 *         methodology.json         (LLM derivation, may be absent)
 *         methodology.md           (human-readable companion)
 *         cover.md                 (cover note from contributor)
 *         links.json               (which SOVREN code paths this affects)
 *         extraction-failed.txt    (if methodology pass failed)
 *
 * The store is single-writer (clawdbot is the only process). Reads use the
 * filesystem directly.
 */

const DEFAULT_ROOT = '/home/james/projects/sovren/notes/methodology-contributions';

export interface ContributionStoreOptions {
  rootDir?: string;
}

export interface AddContributionInput {
  contributor: string;
  contributorSlug: string;
  receivedAt: string;
  kind: ContributionKind;
  shortDescription: string;
  /** Cover text or accompanying chat message body. */
  coverText?: string;
  /** xlsx case. */
  xlsxStructure?: XlsxStructure;
  xlsxBuffer?: Buffer;
  /** PDF/DOCX/text case. */
  documentExcerpt?: DocumentExcerpt;
  documentBuffer?: Buffer;
  /** Burst case. */
  burstMessages?: BurstMessage[];
  /** Optional LLM-derived methodology. */
  methodology?: MethodologyContribution | null;
  /** If the methodology call failed, store the raw output for diagnosis. */
  extractionError?: string | null;
  rawModelOutput?: string | null;
  /** Initial status. Default `pending`. */
  status?: ContributionStatus;
  /** If this contribution supersedes a previous one, supply its id. */
  supersedes?: string | null;
}

export class ContributionStore {
  private readonly rootDir: string;

  constructor(options: ContributionStoreOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_ROOT;
  }

  /** Resolve the on-disk root. Useful for tests and diagnostics. */
  getRootDir(): string {
    return this.rootDir;
  }

  /** Build the canonical id for a contribution. */
  private buildId(slug: string, dateISO: string, titleSlug: string): string {
    const date = dateISO.slice(0, 10);
    return `${slug}/${date}-${titleSlug}`;
  }

  /** Slugify a free-form string for use in a filesystem path. */
  static slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled';
  }

  /** Add a contribution to the store. Returns the new entry. */
  async addContribution(input: AddContributionInput): Promise<ContributionEntry> {
    const titleSlug = ContributionStore.slugify(input.shortDescription);
    const id = this.buildId(input.contributorSlug, input.receivedAt, titleSlug);

    // If a contribution with the same hash already exists for this contributor,
    // return the existing entry rather than creating a duplicate.
    const fileHashes = collectHashes(input);
    const index = await this.loadIndex();
    const dup = findDuplicate(index, input.contributorSlug, fileHashes);
    if (dup) return dup;

    const dir = path.join(this.rootDir, id);
    await fs.mkdir(dir, { recursive: true });

    // Source artifacts.
    const fileNames: string[] = [];
    if (input.xlsxStructure && input.xlsxBuffer) {
      const sourceName = sanitiseFileName(input.xlsxStructure.fileName) || 'source.xlsx';
      await fs.writeFile(path.join(dir, sourceName), input.xlsxBuffer);
      fileNames.push(sourceName);
      await fs.writeFile(
        path.join(dir, 'xlsx-structure.json'),
        JSON.stringify(input.xlsxStructure, null, 2),
      );
    }
    if (input.documentExcerpt) {
      const sourceName = sanitiseFileName(input.documentExcerpt.fileName) || 'source.bin';
      if (input.documentBuffer) {
        await fs.writeFile(path.join(dir, sourceName), input.documentBuffer);
      }
      fileNames.push(sourceName);
      await fs.writeFile(
        path.join(dir, 'document-excerpt.json'),
        JSON.stringify(input.documentExcerpt, null, 2),
      );
    }
    if (input.burstMessages && input.burstMessages.length > 0) {
      await fs.writeFile(
        path.join(dir, 'burst-messages.json'),
        JSON.stringify(input.burstMessages, null, 2),
      );
      // Ensure the burst is also represented in fileNames so the index is non-empty.
      if (fileNames.length === 0) fileNames.push('burst-messages.json');
    }

    // Cover text.
    if (input.coverText && input.coverText.trim().length > 0) {
      await fs.writeFile(path.join(dir, 'cover.md'), input.coverText);
    }

    // Methodology JSON + markdown.
    if (input.methodology) {
      await fs.writeFile(
        path.join(dir, 'methodology.json'),
        JSON.stringify(input.methodology, null, 2),
      );
      await fs.writeFile(
        path.join(dir, 'methodology.md'),
        renderMethodologyMarkdown(input.methodology),
      );
    } else if (input.extractionError) {
      await fs.writeFile(
        path.join(dir, 'extraction-failed.txt'),
        `error: ${input.extractionError}\n\nraw model output:\n${input.rawModelOutput ?? '(none)'}\n`,
      );
    }

    // Empty links.json that James will populate via console (or that the
    // methodology pass populated via suggestedLinks).
    const initialLinks = input.methodology?.suggestedLinks ?? [];
    await fs.writeFile(path.join(dir, 'links.json'), JSON.stringify({ affects: initialLinks }, null, 2));

    // Update index.
    const entry: ContributionEntry = {
      id,
      contributor: input.contributor,
      contributorSlug: input.contributorSlug,
      receivedAt: input.receivedAt,
      kind: input.kind,
      fileNames,
      fileHashes,
      status: input.status ?? 'pending',
      affects: initialLinks,
      supersedes: input.supersedes ?? null,
      shortDescription: input.shortDescription,
    };
    index.contributions.push(entry);

    // If this entry supersedes another, mark the older as superseded.
    if (input.supersedes) {
      const prev = index.contributions.find((c) => c.id === input.supersedes);
      if (prev) prev.status = 'superseded';
    }

    await this.saveIndex(index);
    return entry;
  }

  /** Update the status of an existing entry. */
  async setStatus(id: string, status: ContributionStatus): Promise<boolean> {
    const index = await this.loadIndex();
    const entry = index.contributions.find((c) => c.id === id);
    if (!entry) return false;
    entry.status = status;
    await this.saveIndex(index);
    return true;
  }

  /** Find all contributions affecting a given SOVREN code path. */
  async findByAffects(codePath: string): Promise<ContributionEntry[]> {
    const index = await this.loadIndex();
    return index.contributions.filter((c) =>
      c.affects.some((p) => p === codePath || codePath.startsWith(p) || p.startsWith(codePath)),
    );
  }

  /** Read the index from disk, returning an empty index if absent. */
  async loadIndex(): Promise<ContributionIndex> {
    const indexPath = path.join(this.rootDir, 'index.json');
    try {
      const raw = await fs.readFile(indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as ContributionIndex;
      if (!parsed || !Array.isArray(parsed.contributions)) {
        return { contributions: [] };
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { contributions: [] };
      }
      // Try to recover from a backup before giving up.
      try {
        const backup = await fs.readFile(`${indexPath}.prev`, 'utf-8');
        return JSON.parse(backup) as ContributionIndex;
      } catch {
        return { contributions: [] };
      }
    }
  }

  /** Atomic-ish index write: rotate to .prev then rewrite the live file. */
  private async saveIndex(index: ContributionIndex): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const indexPath = path.join(this.rootDir, 'index.json');
    try {
      await fs.copyFile(indexPath, `${indexPath}.prev`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // intentional: backup failures are non-fatal; we still write the live file.
      }
    }
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }
}

function collectHashes(input: AddContributionInput): string[] {
  const out: string[] = [];
  if (input.xlsxStructure) out.push(input.xlsxStructure.fileHash);
  if (input.documentExcerpt) out.push(input.documentExcerpt.fileHash);
  return out;
}

function findDuplicate(
  index: ContributionIndex,
  contributorSlug: string,
  hashes: string[],
): ContributionEntry | null {
  if (hashes.length === 0) return null;
  for (const entry of index.contributions) {
    if (entry.contributorSlug !== contributorSlug) continue;
    for (const h of hashes) {
      if (entry.fileHashes.includes(h)) return entry;
    }
  }
  return null;
}

function sanitiseFileName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}
