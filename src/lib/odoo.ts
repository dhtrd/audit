// PRE-AUDIT OS — Odoo "General Ledger" report adapter.
//
// Odoo's Accounting > Reporting > General Ledger export (XLSX) is NOT a flat
// table: it is a *grouped* report. A single account is printed as a header
// row (its code + name), followed by an optional opening-balance row, then
// its individual journal lines, then a subtotal ("الإجمالي ...") row. Parent
// groups ("1 الأصول", "11 ...") and a grand total are interleaved too.
//
// The rest of the import engine expects ONE row per real journal line, each
// carrying its own account code. This adapter detects that grouped layout and
// flattens it: it forward-fills the current account code/name down onto every
// dated journal line and drops the group / subtotal / opening-balance rows.
// Row lineage (the true worksheet row number) is preserved on every emitted
// line so each imported figure keeps its exact source_row.
//
// Detection is conservative: a file is only treated as an Odoo ledger report
// when its header row has a code column, a name column, a date column and
// debit/credit columns AND the body actually shows the grouped shape
// (account-header rows with no date + journal rows with no code). A already
// flat GL/TB export never matches, so this adapter is transparent to them.

import type { ParsedSheet } from "./excel";
import { STANDARD_FIELDS, parseDate } from "./import-fields";

// Local copy (kept identical to excel.ts) to avoid a circular import, since
// excel.ts imports this module. Normalizes header text for alias matching.
function normalizeHeader(v: unknown): string {
  return String(v ?? "")
    .replace(/ /g, " ")
    .trim()
    .toLowerCase();
}

// Clean, flat headers we emit — chosen to exactly match STANDARD_FIELDS
// aliases so downstream auto-detection + mapping fill in with no user effort.
export const ODOO_GL_HEADERS = [
  "رمز الحساب",
  "اسم الحساب",
  "التاريخ",
  "المرجع",
  "البيان",
  "الشريك",
  "مدين",
  "دائن",
] as const;

function aliasSet(fieldKey: string, extra: string[] = []): string[] {
  const f = STANDARD_FIELDS[fieldKey];
  const base = f ? f.aliases : [];
  return [...base, ...extra].map((a) => normalizeHeader(a));
}

// Column matchers. `رمز` (code) and `التواصل` (Odoo "Communication"/label)
// are Odoo-report-specific spellings not needed elsewhere, added here.
const CODE_ALIASES = aliasSet("account_code", ["رمز", "رمز الحساب"]);
const NAME_ALIASES = aliasSet("account_name");
const DATE_ALIASES = aliasSet("entry_date");
const DEBIT_ALIASES = aliasSet("debit");
const CREDIT_ALIASES = aliasSet("credit");
const PARTNER_ALIASES = aliasSet("partner");
const COMM_ALIASES = aliasSet("description", ["التواصل", "تواصل", "communication"]);

function matchCol(header: unknown, aliases: string[]): boolean {
  const norm = normalizeHeader(header);
  if (!norm) return false;
  if (aliases.includes(norm)) return true;
  return aliases.some((a) => a.length >= 3 && (norm === a || norm.includes(a) || a.includes(norm)));
}

function findCol(headerCells: unknown[], aliases: string[], exclude: number[] = []): number {
  // exact match first, then contains — skipping columns already taken
  for (let i = 0; i < headerCells.length; i++) {
    if (exclude.includes(i)) continue;
    if (aliases.includes(normalizeHeader(headerCells[i]))) return i;
  }
  for (let i = 0; i < headerCells.length; i++) {
    if (exclude.includes(i)) continue;
    if (matchCol(headerCells[i], aliases)) return i;
  }
  return -1;
}

interface Cols {
  headerIdx: number;
  code: number; name: number; date: number;
  debit: number; credit: number; partner: number; comm: number;
}

function locateHeader(matrix: unknown[][]): Cols | null {
  const scan = Math.min(matrix.length, 12);
  for (let i = 0; i < scan; i++) {
    const cells = matrix[i] ?? [];
    if (cells.length < 4) continue;
    const taken: number[] = [];
    const code = findCol(cells, CODE_ALIASES, taken); if (code >= 0) taken.push(code);
    const name = findCol(cells, NAME_ALIASES, taken); if (name >= 0) taken.push(name);
    const date = findCol(cells, DATE_ALIASES, taken); if (date >= 0) taken.push(date);
    const debit = findCol(cells, DEBIT_ALIASES, taken); if (debit >= 0) taken.push(debit);
    const credit = findCol(cells, CREDIT_ALIASES, taken); if (credit >= 0) taken.push(credit);
    const partner = findCol(cells, PARTNER_ALIASES, taken); if (partner >= 0) taken.push(partner);
    const comm = findCol(cells, COMM_ALIASES, taken); if (comm >= 0) taken.push(comm);
    // A ledger report needs at least: code, name, date, debit, credit.
    if (code >= 0 && name >= 0 && date >= 0 && debit >= 0 && credit >= 0) {
      return { headerIdx: i, code, name, date, debit, credit, partner, comm };
    }
  }
  return null;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function isDateCell(v: unknown): boolean {
  if (v === null || v === undefined || String(v).trim() === "") return false;
  const r = parseDate(v);
  return r.ok && !r.empty && r.value !== null;
}

/** True when the body below the header shows Odoo's grouped shape. */
function looksGrouped(matrix: unknown[][], c: Cols): boolean {
  let accountHeaderRows = 0; // code present, no date
  let journalRows = 0;       // no code, has date
  for (let i = c.headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const hasCode = cellText(row[c.code]) !== "";
    const hasDate = isDateCell(row[c.date]);
    if (hasCode && !hasDate) accountHeaderRows++;
    else if (!hasCode && hasDate) journalRows++;
    if (accountHeaderRows >= 1 && journalRows >= 1 && i > c.headerIdx + 40) break;
  }
  return accountHeaderRows >= 1 && journalRows >= 1;
}

/**
 * Detect and flatten an Odoo grouped General-Ledger report.
 * Returns a normalized ParsedSheet (one clean row per journal line) or null
 * if the matrix is not an Odoo ledger report (caller falls back to generic).
 *
 * `rowOffset` is the worksheet row number of matrix[0] (1 for xlsx/csv), so
 * emitted rowNumber = rowOffset + i preserves true source-row lineage.
 */
export function normalizeOdooLedgerReport(
  sheetName: string,
  matrix: unknown[][],
  rowOffset: number
): ParsedSheet | null {
  const cols = locateHeader(matrix);
  if (!cols) return null;
  if (!looksGrouped(matrix, cols)) return null;

  const headers = [...ODOO_GL_HEADERS];
  const rows: ParsedSheet["rows"] = [];

  let curCode = "";
  let curName = "";

  for (let i = cols.headerIdx + 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    const codeText = cellText(row[cols.code]);
    const hasDate = isDateCell(row[cols.date]);

    if (codeText !== "" && !hasDate) {
      // Leaf-account (or code-bearing) header row → set current account context.
      curCode = codeText;
      curName = cellText(row[cols.name]);
      continue;
    }

    if (hasDate) {
      // A real journal line. Account code is inherited from the header above.
      // On Odoo lines the "name" column carries the move/reference (e.g.
      // MISC/2026/01/0425); the communication column carries the label.
      const reference = cellText(row[cols.name]);
      const comm = cols.comm >= 0 ? cellText(row[cols.comm]) : "";
      const partner = cols.partner >= 0 ? cellText(row[cols.partner]) : "";
      rows.push({
        rowNumber: rowOffset + i,
        cells: {
          "رمز الحساب": curCode || null,
          "اسم الحساب": curName || null,
          "التاريخ": row[cols.date] ?? null,
          "المرجع": reference || null,
          "البيان": comm || null,
          "الشريك": partner || null,
          "مدين": row[cols.debit] ?? null,
          "دائن": row[cols.credit] ?? null,
        },
      });
      continue;
    }

    // Otherwise: group header (code in name col), opening-balance row, or
    // subtotal/total row → not a journal line, skip.
  }

  if (rows.length === 0) return null; // header matched but no lines — let generic try

  return {
    sheetName,
    headers,
    headerRowNumber: rowOffset + cols.headerIdx,
    rows,
  };
}
