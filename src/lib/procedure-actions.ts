// PRE-AUDIT OS — Phase 4 shared server-side orchestration.
// One source of truth for procedure/evidence writes, used by both the
// REST routes and the page server actions. Every write is audit-logged.

import fs from "node:fs";
import {
  type AuditProcedure, type EvidenceFile, type ProcedureStatus,
  getProcedure, getCompany, createProcedure, updateProcedure, addEvidence, writeAuditLog,
} from "./repo";
import { saveUploadedFile, MAX_UPLOAD_BYTES } from "./upload";

export type ProcError = { error: string; code: number };
function err(error: string, code: number): ProcError { return { error, code }; }
export function isProcError(x: unknown): x is ProcError { return !!x && typeof x === "object" && "error" in (x as any); }

const VALID_STATUS: ProcedureStatus[] = ["OPEN", "IN_PROGRESS", "DONE", "NA"];

export function createManualProcedure(input: {
  companyId: string; title: string; description?: string | null; accountCode?: string | null; userId: string | null;
}): AuditProcedure | ProcError {
  if (!getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  if (!input.title || !input.title.trim()) return err("عنوان الإجراء مطلوب", 400);
  const proc = createProcedure({
    companyId: input.companyId, title: input.title.trim(), description: input.description ?? null,
    accountCode: input.accountCode ?? null, severity: "MANUAL", riskType: null, createdBy: input.userId,
  });
  writeAuditLog({ userId: input.userId, action: "PROCEDURE_CREATE", entityType: "AuditProcedure", entityId: proc.id, details: { title: proc.title } });
  return proc;
}

export function updateProcedureAction(input: {
  procedureId: string; status?: ProcedureStatus; conclusion?: string | null; assignedTo?: string | null;
  title?: string; description?: string | null; userId: string | null;
}): AuditProcedure | ProcError {
  const current = getProcedure(input.procedureId);
  if (!current) return err("الإجراء غير موجود", 404);
  if (input.status && !VALID_STATUS.includes(input.status)) return err("حالة غير صالحة", 400);
  if (input.status === "DONE" && !(input.conclusion ?? current.conclusion)) {
    return err("لا يمكن إنهاء الإجراء (DONE) دون استنتاج", 400);
  }
  const updated = updateProcedure(input.procedureId, {
    status: input.status, conclusion: input.conclusion, assignedTo: input.assignedTo,
    title: input.title, description: input.description,
  });
  writeAuditLog({
    userId: input.userId, action: "PROCEDURE_UPDATE", entityType: "AuditProcedure", entityId: input.procedureId,
    details: { status: input.status ?? current.status },
  });
  return updated!;
}

export function addEvidenceFile(input: {
  procedureId: string; fileName: string; buffer: Buffer; note?: string | null; userId: string | null;
}): EvidenceFile | ProcError {
  const proc = getProcedure(input.procedureId);
  if (!proc) return err("الإجراء غير موجود", 404);
  if (!input.fileName) return err("اسم الملف مطلوب", 400);
  if (input.buffer.length === 0) return err("الملف فارغ", 400);
  if (input.buffer.length > MAX_UPLOAD_BYTES) return err("حجم الملف يتجاوز الحد المسموح (20MB)", 413);

  const { storedPath } = saveUploadedFile(input.fileName, input.buffer);
  const ev = addEvidence({
    procedureId: input.procedureId, companyId: proc.company_id, fileName: input.fileName,
    storedPath, fileSize: input.buffer.length, note: input.note ?? null, uploadedBy: input.userId,
  });
  writeAuditLog({
    userId: input.userId, action: "EVIDENCE_UPLOAD", entityType: "AuditProcedure", entityId: input.procedureId,
    details: { fileName: input.fileName, evidenceId: ev.id, size: input.buffer.length },
  });
  return ev;
}

/** Read an evidence file's bytes from disk (for download). */
export function readEvidenceBytes(storedPath: string): Buffer | null {
  try { return fs.readFileSync(storedPath); } catch { return null; }
}
