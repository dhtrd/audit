// PRE-AUDIT OS — Phase 5 shared server-side orchestration
// (findings, adjustments, management review). One source of truth for
// both the REST routes and the page server actions; every write is
// audit-logged, and adjustments must balance (debit = credit).

import {
  type Finding, type FindingSeverity, type FindingStatus, type Adjustment, type AdjustmentStatus,
  type ManagementReview,
  getCompany, getProcedure, createFinding, getFinding, updateFinding,
  createAdjustment, getAdjustment, listAdjustmentLines, setAdjustmentStatus,
  createManagementReview, writeAuditLog,
} from "./repo";

export type P5Error = { error: string; code: number };
function err(error: string, code: number): P5Error { return { error, code }; }
export function isP5Error(x: unknown): x is P5Error { return !!x && typeof x === "object" && "error" in (x as any); }

const EPSILON = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- Findings ----------
export function raiseFinding(input: {
  companyId: string; procedureId?: string | null; accountCode?: string | null; title: string;
  description?: string | null; severity?: FindingSeverity; recommendation?: string | null; userId: string | null;
}): Finding | P5Error {
  if (!getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  if (!input.title?.trim()) return err("عنوان الملاحظة مطلوب", 400);
  if (input.procedureId && !getProcedure(input.procedureId)) return err("الإجراء المرتبط غير موجود", 404);
  const f = createFinding({
    companyId: input.companyId, procedureId: input.procedureId ?? null, accountCode: input.accountCode ?? null,
    title: input.title.trim(), description: input.description ?? null, severity: input.severity,
    recommendation: input.recommendation ?? null, createdBy: input.userId,
  });
  writeAuditLog({ userId: input.userId, action: "FINDING_CREATE", entityType: "Finding", entityId: f.id, details: { title: f.title, severity: f.severity } });
  return f;
}

export function updateFindingAction(input: {
  findingId: string; status?: FindingStatus; managementResponse?: string | null; recommendation?: string | null; severity?: FindingSeverity; userId: string | null;
}): Finding | P5Error {
  const cur = getFinding(input.findingId);
  if (!cur) return err("الملاحظة غير موجودة", 404);
  const updated = updateFinding(input.findingId, {
    status: input.status, managementResponse: input.managementResponse, recommendation: input.recommendation, severity: input.severity,
  });
  writeAuditLog({ userId: input.userId, action: "FINDING_UPDATE", entityType: "Finding", entityId: input.findingId, details: { status: input.status ?? cur.status } });
  return updated!;
}

// ---------- Adjustments ----------
export interface AdjLineInput { accountCode: string; accountName?: string | null; debit: number; credit: number; }

function validateLines(lines: AdjLineInput[]): P5Error | { totalDebit: number; totalCredit: number } {
  if (!lines || lines.length < 2) return err("قيد التسوية يحتاج سطرين على الأقل", 400);
  let td = 0, tc = 0;
  for (const l of lines) {
    if (!l.accountCode?.trim()) return err("كل سطر يحتاج رمز حساب", 400);
    const d = Number(l.debit) || 0, c = Number(l.credit) || 0;
    if (d < 0 || c < 0) return err("لا تُسمح مبالغ سالبة في سطور التسوية", 400);
    if (d > 0 && c > 0) return err("السطر إما مدين أو دائن وليس كليهما", 400);
    if (d === 0 && c === 0) return err("كل سطر يحتاج مبلغًا مدينًا أو دائنًا", 400);
    td += d; tc += c;
  }
  td = round2(td); tc = round2(tc);
  if (td === 0) return err("إجمالي التسوية لا يمكن أن يكون صفرًا", 400);
  if (Math.abs(td - tc) > EPSILON) return err(`قيد التسوية غير متوازن: مدين ${td} ≠ دائن ${tc}`, 400);
  return { totalDebit: td, totalCredit: tc };
}

export function proposeAdjustment(input: {
  companyId: string; findingId?: string | null; description: string; lines: AdjLineInput[]; userId: string | null;
}): Adjustment | P5Error {
  if (!getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  if (!input.description?.trim()) return err("وصف التسوية مطلوب", 400);
  const v = validateLines(input.lines);
  if (isP5Error(v)) return v;
  const adj = createAdjustment({
    companyId: input.companyId, findingId: input.findingId ?? null, description: input.description.trim(),
    lines: input.lines.map((l) => ({ accountCode: l.accountCode.trim(), accountName: l.accountName ?? null, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
    createdBy: input.userId,
  });
  writeAuditLog({ userId: input.userId, action: "ADJUSTMENT_PROPOSE", entityType: "Adjustment", entityId: adj.id, details: { description: adj.description, ...v } });
  return adj;
}

export function decideAdjustment(input: { adjustmentId: string; decision: "APPROVED" | "REJECTED"; userId: string | null }): Adjustment | P5Error {
  const adj = getAdjustment(input.adjustmentId);
  if (!adj) return err("التسوية غير موجودة", 404);
  if (adj.status !== "PROPOSED") return err("لا يمكن تغيير حالة تسوية غير مقترحة", 409);
  if (input.decision === "APPROVED") {
    // re-verify balance before approval (defense in depth)
    const lines = listAdjustmentLines(input.adjustmentId);
    const td = round2(lines.reduce((s, l) => s + l.debit, 0));
    const tc = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (Math.abs(td - tc) > EPSILON) return err(`لا يمكن اعتماد تسوية غير متوازنة (مدين ${td} ≠ دائن ${tc})`, 400);
  }
  const updated = setAdjustmentStatus(input.adjustmentId, input.decision, input.userId);
  writeAuditLog({ userId: input.userId, action: `ADJUSTMENT_${input.decision}`, entityType: "Adjustment", entityId: input.adjustmentId, details: {} });
  return updated!;
}

// ---------- Management review ----------
export function submitManagementReview(input: {
  companyId: string; decision: "APPROVED" | "RETURNED"; notes?: string | null; userId: string | null;
}): ManagementReview | P5Error {
  if (!getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  if (input.decision !== "APPROVED" && input.decision !== "RETURNED") return err("قرار غير صالح", 400);
  const mr = createManagementReview({ companyId: input.companyId, decision: input.decision, notes: input.notes ?? null, reviewedBy: input.userId });
  writeAuditLog({ userId: input.userId, action: "MANAGEMENT_REVIEW", entityType: "ManagementReview", entityId: mr.id, details: { decision: input.decision } });
  return mr;
}
