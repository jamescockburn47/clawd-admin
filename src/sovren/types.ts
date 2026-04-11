/// <reference types="node" />

/**
 * Shared types for the SOVREN methodology contribution store.
 *
 * A "contribution" is anything a registered SOVREN contributor sends in a SOVREN
 * context: spreadsheets, PDFs, Word docs, screenshots, plain text messages, or
 * a multi-message burst that combines several of these. The store records the
 * raw input alongside a structured derivation, so that future updates to the
 * SOVREN engine can cite specific cells, paragraphs, or claims rather than
 * paraphrasing chat logs.
 *
 * See spec: docs/superpowers/specs/2026-04-11-sovren-spreadsheet-ingest-and-contribution-store-design.md
 */

/** Status of a contribution as it moves through review and incorporation. */
export type ContributionStatus =
  | 'pending'
  | 'pending_attachment'
  | 'under_review'
  | 'incorporated'
  | 'rejected'
  | 'superseded';

/** Top-level kind of contribution input. */
export type ContributionKind =
  | 'xlsx'
  | 'pdf'
  | 'docx'
  | 'image'
  | 'text'
  | 'burst';

/** Per-contributor identity used by the registry and store. */
export interface ContributorIdentity {
  /** Stable slug used for filesystem paths. Lowercase, dash-separated. */
  slug: string;
  /** Human-readable display name. */
  displayName: string;
  /** WhatsApp JIDs (phone or LID) belonging to this contributor. */
  jids: string[];
  /** Optional email addresses to match for email-sourced contributions. */
  emails?: string[];
}

/** Result of the deterministic xlsx structural parse. */
export interface XlsxStructure {
  fileName: string;
  fileHash: string;
  sheetCount: number;
  sheets: SheetStructure[];
  definedNames: DefinedName[];
  parsedAt: string;
}

export interface SheetStructure {
  name: string;
  rowCount: number;
  columnCount: number;
  cells: CellRecord[];
  mergedRanges: string[];
}

export type CellType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'empty';

export interface CellRecord {
  address: string;
  row: number;
  column: number;
  value: string | number | boolean | null;
  formula: string | null;
  type: CellType;
  numberFormat: string | null;
}

export interface DefinedName {
  name: string;
  refersTo: string;
}

/** Result of the deterministic generic-document parse (PDF, DOCX, plain text). */
export interface DocumentExcerpt {
  fileName: string;
  fileHash: string;
  mimetype: string;
  text: string;
  charCount: number;
  pageCount: number | null;
  parsedAt: string;
}

/** A single message in a multi-message burst. */
export interface BurstMessage {
  timestamp: string;
  senderName: string;
  text: string;
  attachment: {
    fileName: string;
    mimetype: string;
    captured: boolean;
  } | null;
}

/** Methodology JSON derived from one or more contribution inputs. */
export interface MethodologyContribution {
  contributor: string;
  contributorSlug: string;
  receivedAt: string;
  sourceKind: ContributionKind;
  sourceFiles: { fileName: string; fileHash: string }[];
  variables: VariableSpec[];
  formulas: FormulaSpec[];
  anchors: AnchorReference[];
  workedExamples: WorkedExample[];
  openQuestions: string[];
  conflicts: ConflictNote[];
  suggestedLinks: string[];
  shortDescription: string;
}

export interface VariableSpec {
  name: string;
  definition: string;
  sourceCells: string[];
  domain: string;
}

export interface FormulaSpec {
  label: string;
  symbolic: string;
  sourceCell: string;
  dependsOn: string[];
  appearsInExamples: string[];
}

export interface AnchorReference {
  reference: string;
  meaning: string;
  cells: string[];
}

export interface WorkedExample {
  name: string;
  stage: string;
  inputs: Record<string, string>;
  output: string;
}

export interface ConflictNote {
  with: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
}

/** Top-level entry in the contribution index. */
export interface ContributionEntry {
  id: string;
  contributor: string;
  contributorSlug: string;
  receivedAt: string;
  kind: ContributionKind;
  fileNames: string[];
  fileHashes: string[];
  status: ContributionStatus;
  affects: string[];
  supersedes: string | null;
  shortDescription: string;
}

/** The full index file. */
export interface ContributionIndex {
  contributions: ContributionEntry[];
}
