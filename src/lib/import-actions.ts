// PRE-AUDIT OS — Phase 2 shared server-side orchestration.
//
// One source of truth used by BOTH the REST API (/api/imports*) and the
// page server actions, so the two never drift. HTTP concerns (status
// codes, redirects) stay in the routes/pages; the business logic is here.

import fs from "node:fs";
import {
  type ImportBatch, type ImportFileType,
  createImportBatch, getImportBatch, saveImportMapping, getCompany, writeAuditLog,
} from "./repo";
import { saveUploadedFile, isAllowedFile, repairFileName, MAX_UPLOAD_BYTES } from "./upload";
import { parseFile } from "./excel";
import { detectFileType, matchHeaderToField } from "./detect";
import { STANDARD_FIELDS } from "./import-fields";
import { commitImport, type CommitReport } from "./import-service";

export type ImportError = { error: string; code: number };
function err(error: string, code: number): ImportError { return { error, code }; }
function isErr(x: unknown): x is ImportError { return !!x && typeof x === "object" && "error" in (x as any); }
export { isErr as isImportError };

/** Upload + parse + auto-detect. Creates an UPLOADED batch. */
export async function uploadAndDetect(input: {
  companyId: string;
  fiscalYearId?: string | null;
  fileName: string;
  buffer: Buffer;
  userId: string | null;
}): Promise<ImportBatch | ImportError> {
  if (!input.companyId) return err("الشركة مطلوبة", 400);
  if (!getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  // Repair Arabic file names that arrived mojibake-encoded from the upload.
  const fileName = repairFileName(input.fileName);
  input = { ...input, fileName };
  if (!input.fileName || !isAllowedFile(input.fileName)) {
    return err("صيغة الملف غير مدعومة — استخدم xlsx أو xls أو csv", 400);
  }
  if (input.buffer.length === 0) return err("الملف فارغ", 400);
  if (input.buffer.length > MAX_UPLOAD_BYTES) return err("حجم الملف يتجاوز الحد المسموح (20MB)", 413);

  const { storedPath } = saveUploadedFile(input.fileName, input.buffer);

  let parsed;
  try {
    parsed = await parseFile(storedPath, input.fileName);
  } catch (e: any) {
    return err(`تعذّرت قراءة الملف: ${e?.message ?? "ملف غير صالح"}`, 422);
  }
  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return err("لم يتم العثور على صفوف بيانات في الملف", 422);
  }

  const det = detectFileType(parsed.headers);
  const batch = createImportBatch({
    companyId: input.companyId,
    fiscalYearId: input.fiscalYearId ?? null,
    fileName: input.fileName,
    sheetName: parsed.sheetName,
    fileSize: input.buffer.length,
    storedPath,
    detectedType: det.detectedType,
    detectionConfidence: det.confidence,
    detectionReason: det.reason,
    headers: parsed.headers,
    totalRows: parsed.rows.length,
    createdBy: input.userId,
  });

  // Pre-seed the suggested mapping so the mapping screen opens with a
  // sensible default the user can review/correct. Status becomes MAPPED,
  // but no data is imported until the user explicitly runs the commit.
  if (det.detectedType !== "UNKNOWN" && Object.keys(det.suggestedMapping).length > 0) {
    saveImportMapping(batch.id, { confirmedType: det.detectedType, mapping: det.suggestedMapping });
  }

  writeAuditLog({
    userId: input.userId, action: "IMPORT_UPLOAD", entityType: "ImportBatch", entityId: batch.id,
    details: { fileName: input.fileName, detectedType: det.detectedType, confidence: det.confidence, rows: parsed.rows.length },
  });

  return getImportBatch(batch.id)!;
}

/** Save the user-confirmed type + column mapping. */
export function saveMapping(input: {
  batchId: string; confirmedType: ImportFileType; mapping: Record<string, string>; userId: string | null;
}): ImportBatch | ImportError {
  const batch = getImportBatch(input.batchId);
  if (!batch) return err("دفعة الاستيراد غير موجودة", 404);
  if (input.confirmedType !== "TRIAL_BALANCE" && input.confirmedType !== "GENERAL_LEDGER") {
    return err("نوع الملف غير صالح", 400);
  }
  // Drop empty mapping entries (unmapped fields)
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.mapping)) if (v && v.trim()) clean[k] = v;
  if (!clean["account_code"]) return err("يجب ربط عمود رمز الحساب", 400);
  if (!clean["debit"] || !clean["credit"]) return err("يجب ربط عمودي المدين والدائن", 400);

  const updated = saveImportMapping(input.batchId, { confirmedType: input.confirmedType, mapping: clean });
  writeAuditLog({
    userId: input.userId, action: "IMPORT_MAPPING", entityType: "ImportBatch", entityId: input.batchId,
    details: { confirmedType: input.confirmedType, mapping: clean },
  });
  return updated!;
}

/**
 * Set/change the confirmed file type and re-seed a suggested mapping for
 * that type from the stored headers. Does NOT strictly validate — that
 * happens when the user saves the mapping or runs the commit.
 */
export function setConfirmedType(input: {
  batchId: string; confirmedType: ImportFileType; userId: string | null;
}): ImportBatch | ImportError {
  const batch = getImportBatch(input.batchId);
  if (!batch) return err("دفعة الاستيراد غير موجودة", 404);
  if (input.confirmedType !== "TRIAL_BALANCE" && input.confirmedType !== "GENERAL_LEDGER") {
    return err("نوع الملف غير صالح", 400);
  }
  const headers: string[] = batch.headers_json ? JSON.parse(batch.headers_json) : [];
  const existing: Record<string, string> = batch.mapping_json ? JSON.parse(batch.mapping_json) : {};

  // Build a fresh suggestion for the chosen type, preserving any existing
  // mapping the user already had for fields valid in the new type.
  const suggestion: Record<string, string> = {};
  for (const header of headers) {
    const key = matchHeaderToField(header);
    if (key && STANDARD_FIELDS[key].types.includes(input.confirmedType) && !suggestion[key]) {
      suggestion[key] = header;
    }
  }
  for (const [k, v] of Object.entries(existing)) {
    if (STANDARD_FIELDS[k]?.types.includes(input.confirmedType) && headers.includes(v)) suggestion[k] = v;
  }

  const updated = saveImportMapping(input.batchId, { confirmedType: input.confirmedType, mapping: suggestion });
  writeAuditLog({
    userId: input.userId, action: "IMPORT_SET_TYPE", entityType: "ImportBatch", entityId: input.batchId,
    details: { confirmedType: input.confirmedType },
  });
  return updated!;
}

export interface AutoImportResult {
  fileName: string;
  status: "COMMITTED" | "BLOCKED" | "NEEDS_MAPPING" | "ERROR";
  rows?: number;
  detail?: string;
  batchId?: string;
}

/**
 * One-shot import for a single file: upload + auto-detect + (if the type was
 * recognised and the required columns auto-mapped) validate + reconcile +
 * commit. Files whose columns can't be auto-mapped are left as an UPLOADED
 * batch for manual mapping — never guessed. The mandatory reconciliation is
 * still enforced, so an unbalanced file is BLOCKED, not silently kept.
 * Used by the multi-file uploader so many ledger months import in one action.
 */
export async function autoImportOne(input: {
  companyId: string;
  fiscalYearId?: string | null;
  fileName: string;
  buffer: Buffer;
  userId: string | null;
}): Promise<AutoImportResult> {
  const up = await uploadAndDetect(input);
  if (isErr(up)) return { fileName: input.fileName, status: "ERROR", detail: up.error };
  const batch = up;
  const mapping = batch.mapping_json ? (JSON.parse(batch.mapping_json) as Record<string, string>) : {};
  const autoMapped = !!batch.confirmed_type && !!mapping.account_code && !!mapping.debit && !!mapping.credit;
  if (!autoMapped) {
    return { fileName: input.fileName, status: "NEEDS_MAPPING", batchId: batch.id };
  }
  const rep = await runCommit({ batchId: batch.id, userId: input.userId });
  if (isErr(rep)) return { fileName: input.fileName, status: "ERROR", detail: rep.error, batchId: batch.id };
  return {
    fileName: input.fileName,
    status: rep.status,
    rows: rep.detailRowCount,
    batchId: batch.id,
    detail: rep.status === "BLOCKED" ? "فرق التسوية ≠ 0 — لم تُعتمد البيانات" : undefined,
  };
}

/** Run validation + reconciliation + commit (or BLOCK). */
export async function runCommit(input: { batchId: string; userId: string | null }): Promise<CommitReport | ImportError> {
  const batch = getImportBatch(input.batchId);
  if (!batch) return err("دفعة الاستيراد غير موجودة", 404);
  if (!batch.confirmed_type || !batch.mapping_json) return err("أكمل ربط الأعمدة أولًا", 400);
  if (!fs.existsSync(batch.stored_path)) return err("الملف المصدر غير متوفر على الخادم", 410);

  let report: CommitReport;
  try {
    report = await commitImport(batch);
  } catch (e: any) {
    return err(e?.message ?? "فشل الاستيراد", 422);
  }

  writeAuditLog({
    userId: input.userId, action: "IMPORT_COMMIT", entityType: "ImportBatch", entityId: input.batchId,
    details: {
      fileName: batch.file_name, result: report.status, quality: report.quality.score,
      rows: report.detailRowCount, reconciliation: report.reconciliation,
    },
  });
  return report;
}
