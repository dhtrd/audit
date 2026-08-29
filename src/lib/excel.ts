// PRE-AUDIT OS — Phase 2 file reading.
//
// Reads a real .xlsx / .xls (via exceljs) or .csv file from disk and
// returns a normalized { sheetName, headers, rows } shape. `rows` keeps
// the true 1-based worksheet row number of every record so that each
// imported number can carry its exact data lineage (file / sheet / row).
//
// It also finds the header row instead of blindly assuming row 1 —
// real exported files often have a title / company banner above the
// actual column headers.

import ExcelJS from "exceljs";
import fs from "node:fs";
import { STANDARD_FIELDS } from "./import-fields";
import { normalizeOdooLedgerReport } from "./odoo";

export interface ParsedSheet {
  sheetName: string;
  /** Header labels exactly as they appear in the file (trimmed). */
  headers: string[];
  /** Header-row number in the worksheet (1-based). */
  headerRowNumber: number;
  /** One entry per data row: the raw cell values keyed by header, plus lineage. */
  rows: { rowNumber: number; cells: Record<string, unknown> }[];
}

/** All keyword aliases we recognise, used only to locate the header row. */
const HEADER_HINTS: string[] = Object.values(STANDARD_FIELDS)
  .flatMap((f) => f.aliases)
  .map((a) => normalizeHeader(a));

export function normalizeHeader(v: unknown): string {
  return String(v ?? "")
    .replace(/ /g, " ")
    .trim()
    .toLowerCase();
}

function cellToPrimitive(value: unknown): unknown {
  if (value == null) return null;
  // exceljs rich-text / hyperlink / formula objects
  if (typeof value === "object") {
    const v = value as any;
    if (v instanceof Date) return v;
    if (typeof v.text === "string") return v.text;
    if (typeof v.result !== "undefined") return v.result;
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join("");
    if (typeof v.hyperlink === "string" && typeof v.text === "string") return v.text;
    return String(v);
  }
  return value;
}

function pickHeaderRow(matrix: unknown[][]): number {
  // Score the first 15 rows by how many cells match a known field alias;
  // fall back to the first row that has >= 2 non-empty text cells.
  let best = -1;
  let bestScore = 0;
  const scan = Math.min(matrix.length, 15);
  for (let i = 0; i < scan; i++) {
    const cells = matrix[i] ?? [];
    let score = 0;
    let nonEmptyText = 0;
    for (const cell of cells) {
      const norm = normalizeHeader(cell);
      if (norm) nonEmptyText++;
      if (norm && HEADER_HINTS.includes(norm)) score += 2;
      else if (norm && HEADER_HINTS.some((h) => h.length > 2 && norm.includes(h))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best >= 0) return best;
  // fallback: first row with >= 2 non-empty cells
  for (let i = 0; i < scan; i++) {
    const nonEmpty = (matrix[i] ?? []).filter((c) => normalizeHeader(c)).length;
    if (nonEmpty >= 2) return i;
  }
  return 0;
}

function buildFromMatrix(sheetName: string, matrix: unknown[][], rowOffset: number): ParsedSheet {
  // rowOffset = worksheet row number of matrix[0] (1 for xlsx eachRow, 1 for csv)
  const headerIdx = pickHeaderRow(matrix);
  const rawHeaders = (matrix[headerIdx] ?? []).map((h) => String(cellDisplay(h)).replace(/ /g, " ").trim());

  // De-duplicate blank / repeated headers so mapping keys stay unique.
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h, idx) => {
    let name = h || `العمود ${idx + 1}`;
    if (seen.has(name)) {
      const n = seen.get(name)! + 1;
      seen.set(name, n);
      name = `${name} (${n})`;
    } else {
      seen.set(name, 1);
    }
    return name;
  });

  const rows: ParsedSheet["rows"] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const rowCells = matrix[i] ?? [];
    const cells: Record<string, unknown> = {};
    let anyValue = false;
    headers.forEach((h, idx) => {
      const val = rowCells[idx] ?? null;
      cells[h] = val;
      if (val !== null && String(val).trim() !== "") anyValue = true;
    });
    if (!anyValue) continue; // skip fully-empty rows
    rows.push({ rowNumber: rowOffset + i, cells });
  }

  return { sheetName, headers, headerRowNumber: rowOffset + headerIdx, rows };
}

function cellDisplay(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function parseXlsx(filePath: string): Promise<ParsedSheet> {
  // Stream the workbook row-by-row instead of loading the entire object model
  // into memory. A real ledger month is ~127k rows / 6 MB; the non-streaming
  // reader builds a huge in-memory workbook that can exhaust RAM and crash the
  // server. The streaming reader keeps peak memory low and stable.
  const reader = new (ExcelJS as any).stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: "cache",
    hyperlinks: "ignore",
    styles: "ignore",
    worksheets: "emit",
  });

  const matrix: unknown[][] = [];
  let sheetName = "Sheet1";
  let captured = false;

  for await (const worksheet of reader) {
    // Take the first worksheet that actually has rows; ignore the rest.
    if (captured) break;
    sheetName = (worksheet as any).name || sheetName;
    let maxRow = 0;
    const byNumber = new Map<number, unknown[]>();
    for await (const row of worksheet as any) {
      const rowNumber: number = row.number;
      // row.values is 1-based (index 0 unused); normalize each cell.
      const vals = row.values as unknown[];
      const out: unknown[] = [];
      for (let c = 1; c < vals.length; c++) out.push(cellToPrimitive(vals[c]));
      byNumber.set(rowNumber, out);
      if (rowNumber > maxRow) maxRow = rowNumber;
    }
    if (maxRow > 0) {
      for (let r = 1; r <= maxRow; r++) matrix.push(byNumber.get(r) ?? []);
      captured = true;
    }
  }

  if (matrix.length === 0) throw new Error("لا توجد أوراق عمل في الملف");

  // matrix[i] is worksheet row (i+1); rowOffset=1 => rowNumber = 1 + i (true 1-based row)
  // First try the Odoo grouped-ledger adapter; fall back to the generic reader.
  const odoo = normalizeOdooLedgerReport(sheetName, matrix, 1);
  if (odoo) return odoo;
  return buildFromMatrix(sheetName, matrix, 1);
}

/** Minimal but correct CSV parser: quoted fields, escaped quotes, CRLF, BOM. */
export function parseCsvText(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* skip, handled by \n */ }
      else field += ch;
    }
  }
  // last field/row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export async function parseCsv(filePath: string): Promise<ParsedSheet> {
  const text = fs.readFileSync(filePath, "utf8");
  const matrix = parseCsvText(text);
  // matrix[i] is line (i+1); rowOffset=1 keeps source_row 1-based like a spreadsheet.
  const odoo = normalizeOdooLedgerReport("CSV", matrix, 1);
  if (odoo) return odoo;
  return buildFromMatrix("CSV", matrix, 1);
}

export async function parseFile(filePath: string, originalName: string): Promise<ParsedSheet> {
  const lower = originalName.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsv(filePath);
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm") || lower.endsWith(".xls")) return parseXlsx(filePath);
  // Fallback: sniff — try xlsx, then csv
  try {
    return await parseXlsx(filePath);
  } catch {
    return parseCsv(filePath);
  }
}
