// PRE-AUDIT OS — Phase 3 shared server-side orchestration.
// One source of truth for the materiality write, used by both the REST
// route and the page server action.

import { setMateriality, getCompany, writeAuditLog, type MaterialitySetting } from "./repo";

export type RiskError = { error: string; code: number };
function err(error: string, code: number): RiskError { return { error, code }; }
export function isRiskError(x: unknown): x is RiskError { return !!x && typeof x === "object" && "error" in (x as any); }

export function saveMateriality(input: {
  companyId: string; fiscalYearId?: string | null; amount: number; basisNote?: string | null; userId: string | null;
}): MaterialitySetting | RiskError {
  if (!input.companyId || !getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  if (!Number.isFinite(input.amount) || input.amount <= 0) return err("الأهمية النسبية يجب أن تكون رقمًا موجبًا", 400);
  const saved = setMateriality({
    companyId: input.companyId,
    fiscalYearId: input.fiscalYearId ?? null,
    amount: input.amount,
    basisNote: input.basisNote ?? null,
    createdBy: input.userId,
  });
  writeAuditLog({
    userId: input.userId, action: "MATERIALITY_SET", entityType: "MaterialitySetting", entityId: saved.id,
    details: { companyId: input.companyId, fiscalYearId: input.fiscalYearId ?? null, amount: input.amount },
  });
  return saved;
}
