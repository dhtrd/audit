// PRE-AUDIT OS — Phase 2 import engine.
//
// Turns a parsed file + a column mapping into typed rows, runs REAL
// validation (balance, missing accounts, invalid numbers/dates,
// duplicates) into an explainable quality score, and commits into the
// database inside a transaction with a MANDATORY source-vs-imported
// reconciliation. If the reconciliation difference is not zero the data
// is rolled back and the batch is marked BLOCKED — never silently kept.

import {
  type ImportBatch, type ImportFileType,
  insertTrialBalanceRows, insertGeneralLedgerRows,
  sumTrialBalanceImported, sumGeneralLedgerImported,
  deleteImportedRows, saveImportResult, transaction,
} from "./repo";
import { parseFile, type ParsedSheet } from "./excel";
import { parseNumber, parseDate, parseText, requiredFieldsForType } from "./import-fields";

const EPSILON = 0.005; // 0.5 fils — floating tolerance for money sums

export interface QualityCheck {
  id: string;
  label: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
  affectedRows: number[]; // source row numbers (capped for display)
  affectedCount: number;
}

export interface TransformedTB {
  accountCode: string; accountName: string | null;
  openingBalance: number; debit: number; credit: number; closingBalance: number;
  sourceRow: number;
}
export interface TransformedGL {
  entryDate: string | null; journal: string | null; accountCode: string; accountName: string | null;
  partner: string | null; reference: string | null; description: string | null;
  debit: number; credit: number; sourceRow: number;
}

export interface AnalyzeResult {
  type: ImportFileType;
  parsed: ParsedSheet;
  tbRows: TransformedTB[];
  glRows: TransformedGL[];
  detailRowCount: number;
  declaredTotal: { debit: number; credit: number; sourceRow: number } | null;
  sourceTotalDebit: number;   // authoritative source total (declared row if present, else sum of details)
  sourceTotalCredit: number;
  detailSumDebit: number;     // sum of the detail rows we will import
  detailSumCredit: number;
  quality: { score: number; checks: QualityCheck[] };
}

const TOTAL_ROW_RE = /(^|\s)(total|totals|grand total|الإجمالي|الاجمالي|المجموع|إجمالي|اجمالي|الإجمالى)(\s|$|:)/i;

function isTotalRow(accountCode: string | null, accountName: string | null): boolean {
  const a = (accountCode ?? "").trim();
  const b = (accountName ?? "").trim();
  // A total row typically has no real account code but a "Total" label.
  const codeIsTotal = TOTAL_ROW_RE.test(a);
  const nameIsTotal = TOTAL_ROW_RE.test(b);
  const codeIsNumeric = /\d/.test(a);
  return (nameIsTotal || codeIsTotal) && !codeIsNumeric;
}

export async function analyzeImport(batch: ImportBatch): Promise<AnalyzeResult> {
  if (!batch.confirmed_type) throw new Error("نوع الملف غير مؤكَّد");
  if (!batch.mapping_json) throw new Error("لم يتم ربط الأعمدة بعد");
  const type = batch.confirmed_type;
  const mapping = JSON.parse(batch.mapping_json) as Record<string, string>;

  const parsed = await parseFile(batch.stored_path, batch.file_name);

  const get = (cells: Record<string, unknown>, fieldKey: string): unknown => {
    const header = mapping[fieldKey];
    if (!header) return null;
    return cells[header] ?? null;
  };

  const checks: QualityCheck[] = [];
  const missingAccount: number[] = [];
  const invalidNumber: number[] = [];
  const invalidDate: number[] = [];
  const dupRows: number[] = [];
  const seenKeys = new Set<string>();

  const tbRows: TransformedTB[] = [];
  const glRows: TransformedGL[] = [];
  let declaredTotal: AnalyzeResult["declaredTotal"] = null;

  for (const { rowNumber, cells } of parsed.rows) {
    const accountCode = parseText(get(cells, "account_code"));
    const accountName = parseText(get(cells, "account_name"));
    const dRes = parseNumber(get(cells, "debit"));
    const cRes = parseNumber(get(cells, "credit"));
    if (!dRes.ok || !cRes.ok) invalidNumber.push(rowNumber);
    const debit = dRes.value;
    const credit = cRes.value;

    // Detect a declared total row (excluded from detail import; used for reconciliation)
    if (isTotalRow(accountCode, accountName)) {
      declaredTotal = { debit, credit, sourceRow: rowNumber };
      continue;
    }

    if (!accountCode) { missingAccount.push(rowNumber); }

    if (type === "TRIAL_BALANCE") {
      const openRes = parseNumber(get(cells, "opening_balance"));
      const closeRes = parseNumber(get(cells, "closing_balance"));
      if (!openRes.ok || !closeRes.ok) invalidNumber.push(rowNumber);
      // dedupe key for TB = account code
      const key = (accountCode ?? "").toLowerCase();
      if (accountCode) {
        if (seenKeys.has(key)) dupRows.push(rowNumber);
        else seenKeys.add(key);
      }
      tbRows.push({
        accountCode: accountCode ?? "",
        accountName,
        openingBalance: openRes.value,
        debit, credit,
        closingBalance: closeRes.value,
        sourceRow: rowNumber,
      });
    } else {
      const dateRes = parseDate(get(cells, "entry_date"));
      if (!dateRes.ok) invalidDate.push(rowNumber);
      const journal = parseText(get(cells, "journal"));
      const partner = parseText(get(cells, "partner"));
      const reference = parseText(get(cells, "reference"));
      const description = parseText(get(cells, "description"));
      // dedupe key for GL = date|account|debit|credit|reference|description
      const key = [dateRes.value, accountCode, debit, credit, reference, description].join("|").toLowerCase();
      if (seenKeys.has(key)) dupRows.push(rowNumber);
      else seenKeys.add(key);
      glRows.push({
        entryDate: dateRes.value, journal, accountCode: accountCode ?? "", accountName,
        partner, reference, description, debit, credit, sourceRow: rowNumber,
      });
    }
  }

  const detailRowCount = type === "TRIAL_BALANCE" ? tbRows.length : glRows.length;
  const detailSumDebit = round2((type === "TRIAL_BALANCE" ? tbRows : glRows).reduce((s, r) => s + r.debit, 0));
  const detailSumCredit = round2((type === "TRIAL_BALANCE" ? tbRows : glRows).reduce((s, r) => s + r.credit, 0));

  // Authoritative source total: the file's own declared total row if present,
  // otherwise the sum of the detail rows (self-consistent).
  const sourceTotalDebit = declaredTotal ? round2(declaredTotal.debit) : detailSumDebit;
  const sourceTotalCredit = declaredTotal ? round2(declaredTotal.credit) : detailSumCredit;

  // ---- Quality checks (real, computed) ----
  // 1) Debit = Credit balance
  const balanceDiff = round2(detailSumDebit - detailSumCredit);
  checks.push({
    id: "balance",
    label: "توازن المدين والدائن (مدين = دائن)",
    status: Math.abs(balanceDiff) <= EPSILON ? "PASS" : "FAIL",
    detail: Math.abs(balanceDiff) <= EPSILON
      ? `متوازن: مدين ${fmt(detailSumDebit)} = دائن ${fmt(detailSumCredit)}`
      : `غير متوازن: مدين ${fmt(detailSumDebit)} ≠ دائن ${fmt(detailSumCredit)} (فرق ${fmt(balanceDiff)})`,
    affectedRows: [], affectedCount: Math.abs(balanceDiff) <= EPSILON ? 0 : 1,
  });
  // 2) Missing account codes
  checks.push(makeCountCheck("missing_account", "حسابات مفقودة (بدون رمز حساب)", missingAccount,
    "لا توجد صفوف بدون رمز حساب", (n) => `${n} صف بدون رمز حساب`));
  // 3) Invalid numbers
  checks.push(makeCountCheck("invalid_number", "مبالغ غير صالحة (تعذّر قراءتها كرقم)", uniq(invalidNumber),
    "جميع المبالغ صالحة", (n) => `${n} صف يحتوي مبلغًا غير صالح`));
  // 4) Invalid dates (GL only)
  if (type === "GENERAL_LEDGER") {
    checks.push(makeCountCheck("invalid_date", "تواريخ غير صالحة", invalidDate,
      "جميع التواريخ صالحة", (n) => `${n} صف يحتوي تاريخًا غير صالح`));
  }
  // 5) Duplicate rows
  checks.push(makeCountCheck("duplicates", type === "TRIAL_BALANCE" ? "حسابات مكرّرة" : "قيود مكرّرة", dupRows,
    "لا توجد صفوف مكرّرة", (n) => `${n} صف مكرّر`));

  // ---- Quality score (deterministic weighting, never random) ----
  let score = 100;
  if (Math.abs(balanceDiff) > EPSILON) score -= 30;
  score -= Math.min(missingAccount.length * 2, 20);
  score -= Math.min(uniq(invalidNumber).length * 3, 20);
  score -= Math.min(invalidDate.length * 2, 10);
  score -= Math.min(dupRows.length * 2, 15);
  score = Math.max(0, Math.round(score));

  return {
    type, parsed, tbRows, glRows, detailRowCount, declaredTotal,
    sourceTotalDebit, sourceTotalCredit, detailSumDebit, detailSumCredit,
    quality: { score, checks },
  };
}

export interface CommitReport {
  status: "COMMITTED" | "BLOCKED";
  reconciliation: {
    sourceTotalDebit: number; sourceTotalCredit: number;
    importedTotalDebit: number; importedTotalCredit: number;
    differenceDebit: number; differenceCredit: number;
    balanced: boolean; // difference == 0 on both sides
  };
  quality: { score: number; checks: QualityCheck[] };
  detailRowCount: number;
  declaredTotalPresent: boolean;
}

export async function commitImport(batch: ImportBatch): Promise<CommitReport> {
  const analysis = await analyzeImport(batch);
  const { type } = analysis;

  // Guard: required fields must be mapped
  const mapping = JSON.parse(batch.mapping_json!) as Record<string, string>;
  const missingRequired = requiredFieldsForType(type).filter((f) => !mapping[f.key]);
  if (missingRequired.length > 0) {
    throw new Error(`حقول إلزامية غير مربوطة: ${missingRequired.map((f) => f.label).join("، ")}`);
  }

  const batchRef = {
    id: batch.id, company_id: batch.company_id, fiscal_year_id: batch.fiscal_year_id,
    file_name: batch.file_name, sheet_name: analysis.parsed.sheetName,
  };

  // Insert detail rows inside a transaction (fresh — remove any prior import for this batch first)
  transaction(() => {
    deleteImportedRows(batch.id);
    if (type === "TRIAL_BALANCE") insertTrialBalanceRows(batchRef, analysis.tbRows);
    else insertGeneralLedgerRows(batchRef, analysis.glRows);
  });

  // MANDATORY reconciliation: authoritative source total vs what actually
  // landed in the database (read back via SQL SUM — the real stored data).
  const imported = type === "TRIAL_BALANCE"
    ? sumTrialBalanceImported(batch.id)
    : sumGeneralLedgerImported(batch.id);
  const importedTotalDebit = round2(imported.debit);
  const importedTotalCredit = round2(imported.credit);
  const differenceDebit = round2(analysis.sourceTotalDebit - importedTotalDebit);
  const differenceCredit = round2(analysis.sourceTotalCredit - importedTotalCredit);
  const balanced = Math.abs(differenceDebit) <= EPSILON && Math.abs(differenceCredit) <= EPSILON;

  const status: CommitReport["status"] = balanced ? "COMMITTED" : "BLOCKED";

  // If reconciliation fails, do NOT keep the data — remove it so nothing
  // half-imported can be mistaken for verified data.
  if (!balanced) {
    transaction(() => { deleteImportedRows(batch.id); });
  }

  saveImportResult(batch.id, {
    status,
    qualityScore: analysis.quality.score,
    qualityJson: analysis.quality.checks,
    totalRows: analysis.detailRowCount,
    sourceTotalDebit: analysis.sourceTotalDebit,
    sourceTotalCredit: analysis.sourceTotalCredit,
    importedTotalDebit,
    importedTotalCredit,
    reconDifference: round2(Math.max(Math.abs(differenceDebit), Math.abs(differenceCredit))),
  });

  return {
    status,
    reconciliation: {
      sourceTotalDebit: analysis.sourceTotalDebit,
      sourceTotalCredit: analysis.sourceTotalCredit,
      importedTotalDebit, importedTotalCredit,
      differenceDebit, differenceCredit, balanced,
    },
    quality: analysis.quality,
    detailRowCount: analysis.detailRowCount,
    declaredTotalPresent: analysis.declaredTotal !== null,
  };
}

// ---------------- helpers ----------------
function round2(n: number): number { return Math.round(n * 100) / 100; }
function fmt(n: number): string { return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function uniq(a: number[]): number[] { return Array.from(new Set(a)); }
function makeCountCheck(id: string, label: string, rows: number[], okDetail: string, badDetail: (n: number) => string): QualityCheck {
  const count = rows.length;
  return {
    id, label,
    status: count === 0 ? "PASS" : (id === "duplicates" || id === "invalid_date" ? "WARN" : "FAIL"),
    detail: count === 0 ? okDetail : badDetail(count),
    affectedRows: rows.slice(0, 20),
    affectedCount: count,
  };
}
