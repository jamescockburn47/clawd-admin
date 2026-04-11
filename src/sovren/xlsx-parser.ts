/// <reference types="node" />
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import type {
  CellRecord,
  CellType,
  DefinedName,
  SheetStructure,
  XlsxStructure,
} from './types.js';

/**
 * Deterministic structural parser for `.xlsx` and `.xls` files.
 *
 * Hard rules (per spec §6.1):
 * - No truncation. Every non-empty cell appears in the output.
 * - Cell `value` is the computed result; `formula` is the source formula.
 * - File hash is computed from the original buffer and stored.
 * - No LLM, no inference, no interpretation. Output is reproducible byte-for-
 *   byte from the input.
 *
 * The output of this parser is the canonical record of the spreadsheet. The
 * methodology extractor (separate module) reads this output, never the raw
 * file.
 */

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function classifyCellType(cell: ExcelJS.Cell): CellType {
  // Cell type from exceljs is a numeric enum (Null, Merge, Number, String, Date, Hyperlink, Formula, ...)
  switch (cell.type) {
    case ExcelJS.ValueType.Null:
    case ExcelJS.ValueType.Merge:
      return 'empty';
    case ExcelJS.ValueType.Number:
      return 'number';
    case ExcelJS.ValueType.String:
    case ExcelJS.ValueType.RichText:
    case ExcelJS.ValueType.SharedString:
      return 'string';
    case ExcelJS.ValueType.Boolean:
      return 'boolean';
    case ExcelJS.ValueType.Date:
      return 'date';
    case ExcelJS.ValueType.Formula:
      return 'formula';
    case ExcelJS.ValueType.Hyperlink:
      return 'string';
    case ExcelJS.ValueType.Error:
      return 'string';
    default:
      return 'empty';
  }
}

function extractCellValue(
  cell: ExcelJS.Cell,
): string | number | boolean | null {
  if (cell.value === null || cell.value === undefined) return null;

  // Formula cells: use the cached result, not the formula string itself.
  if (cell.type === ExcelJS.ValueType.Formula) {
    const formulaValue = cell.value as ExcelJS.CellFormulaValue;
    const result = formulaValue.result;
    if (result === null || result === undefined) return null;
    if (typeof result === 'object' && result !== null) {
      const obj = result as unknown as Record<string, unknown>;
      if ('error' in obj) {
        return `#ERROR:${String(obj.error)}`;
      }
      if (result instanceof Date) return result.toISOString();
      if ('richText' in obj) {
        const rich = obj.richText as { text: string }[];
        return rich.map((r) => r.text).join('');
      }
    }
    return result as string | number | boolean;
  }

  // Rich text cells.
  if (cell.type === ExcelJS.ValueType.RichText) {
    const rich = cell.value as ExcelJS.CellRichTextValue;
    return rich.richText.map((r) => r.text).join('');
  }

  // Hyperlink cells.
  if (cell.type === ExcelJS.ValueType.Hyperlink) {
    const link = cell.value as ExcelJS.CellHyperlinkValue;
    return link.text ?? link.hyperlink ?? null;
  }

  // Date cells.
  if (cell.value instanceof Date) return cell.value.toISOString();

  // Plain primitives.
  if (
    typeof cell.value === 'string' ||
    typeof cell.value === 'number' ||
    typeof cell.value === 'boolean'
  ) {
    return cell.value;
  }

  // Anything else (shared strings as objects, error objects, etc.) — best-effort string.
  return JSON.stringify(cell.value);
}

function extractFormula(cell: ExcelJS.Cell): string | null {
  if (cell.type !== ExcelJS.ValueType.Formula) return null;
  const f = cell.value as unknown as Record<string, unknown>;
  if (typeof f.formula === 'string') return f.formula;
  if (typeof f.sharedFormula === 'string') return f.sharedFormula as string;
  return null;
}

function extractSheetStructure(worksheet: ExcelJS.Worksheet): SheetStructure {
  const cells: CellRecord[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const type = classifyCellType(cell);
      if (type === 'empty') return;
      const record: CellRecord = {
        address: cell.address,
        row: rowNumber,
        column: colNumber,
        value: extractCellValue(cell),
        formula: extractFormula(cell),
        type,
        numberFormat: (cell.numFmt as string | null) ?? null,
      };
      cells.push(record);
    });
  });

  const mergedRanges: string[] = [];
  // exceljs stores merges as a map of master-cell address -> merge model.
  // The public surface is `_merges` (private but stable) or worksheet.model.merges.
  const merges = (worksheet as unknown as { _merges?: Record<string, { range: string }> })
    ._merges;
  if (merges) {
    for (const key of Object.keys(merges)) {
      const range = merges[key]?.range;
      if (range && !mergedRanges.includes(range)) mergedRanges.push(range);
    }
  }

  return {
    name: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    cells,
    mergedRanges,
  };
}

function extractDefinedNames(workbook: ExcelJS.Workbook): DefinedName[] {
  const result: DefinedName[] = [];
  // exceljs exposes defined names via workbook.definedNames (a DefinedNames instance).
  // The implementation surface for iteration isn't on the public types, so we
  // reach in via the model. Defended with optional chaining.
  const model = (workbook as unknown as {
    definedNames?: { model?: { name: string; ranges: string[] }[] };
  }).definedNames;
  const definedList = model?.model;
  if (Array.isArray(definedList)) {
    for (const entry of definedList) {
      if (entry?.name && Array.isArray(entry.ranges)) {
        for (const r of entry.ranges) {
          result.push({ name: entry.name, refersTo: r });
        }
      }
    }
  }
  return result;
}

/** Parse an xlsx buffer into a deterministic structure. */
export async function parseXlsx(
  buffer: Buffer,
  fileName: string,
): Promise<XlsxStructure> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's type definition asks for `Buffer` but at runtime accepts ArrayBuffer.
  // The Node `Buffer` type is generic over its underlying buffer; cast through
  // `unknown` to keep strict null checks happy without changing runtime behaviour.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const sheets: SheetStructure[] = [];
  workbook.eachSheet((worksheet) => {
    sheets.push(extractSheetStructure(worksheet));
  });

  return {
    fileName,
    fileHash: sha256(buffer),
    sheetCount: sheets.length,
    sheets,
    definedNames: extractDefinedNames(workbook),
    parsedAt: new Date().toISOString(),
  };
}

/**
 * Build a compact text rendering of the structure suitable for prompting an
 * LLM. Includes every cell with formula or non-trivial value. Does NOT
 * truncate sheets but does drop cells whose value is empty/null.
 */
export function renderStructureForPrompt(structure: XlsxStructure): string {
  const lines: string[] = [];
  lines.push(`File: ${structure.fileName}`);
  lines.push(`Sheets: ${structure.sheetCount}`);
  if (structure.definedNames.length > 0) {
    lines.push('');
    lines.push('Defined names:');
    for (const dn of structure.definedNames) {
      lines.push(`  ${dn.name} -> ${dn.refersTo}`);
    }
  }
  for (const sheet of structure.sheets) {
    lines.push('');
    lines.push(`--- Sheet: ${sheet.name} (${sheet.rowCount} rows x ${sheet.columnCount} cols) ---`);
    for (const cell of sheet.cells) {
      if (cell.formula) {
        lines.push(`  ${cell.address} = ${cell.formula}    [value=${formatCellValue(cell.value)}]`);
      } else if (cell.value !== null && cell.value !== '') {
        lines.push(`  ${cell.address}: ${formatCellValue(cell.value)}`);
      }
    }
  }
  return lines.join('\n');
}

function formatCellValue(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value === 'number') {
    // Trim trailing zeros, keep up to 6 sig figs of detail.
    return Number.isInteger(value) ? String(value) : value.toString();
  }
  if (typeof value === 'string') return value;
  return String(value);
}
