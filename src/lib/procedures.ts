// PRE-AUDIT OS — Phase 4 procedure generation & coverage.
//
// Turns the Phase 3 risk flags into concrete audit procedures (one per
// distinct risk_type + account) and measures how much of the assessed
// risk is actually covered by a resolved procedure. Everything is derived
// from real risk output — no invented work items.

import { analyzeRisk, type Severity } from "./risk";
import {
  getMateriality, existingProcedureKeys, resolvedProcedureKeys, createProcedure,
  writeAuditLog, type AuditProcedure, type ProcedureSeverity,
} from "./repo";

export interface ProcedureSuggestion {
  riskType: string;
  accountCode: string | null;
  severity: ProcedureSeverity;
  title: string;
  description: string;
  flagCount: number;
}

function keyOf(riskType: string, accountCode: string | null): string {
  return `${riskType}|${accountCode ?? ""}`;
}

// Standard pre-audit procedure templates per risk type.
function template(riskType: string, accountCode: string | null, count: number): { title: string; description: string } {
  const acct = accountCode ? `الحساب ${accountCode}` : "";
  switch (riskType) {
    case "TB_GL_MISMATCH":
      return {
        title: `تسوية ${acct} بين الميزان والأستاذ العام`,
        description: `افحص سبب الفرق بين صافي الميزان وصافي حركة الأستاذ العام لـ${acct}، وثّق التسوية بالمستندات المؤيدة.`,
      };
    case "LARGE_ITEM":
      return {
        title: `فحص البنود الكبيرة في ${acct}`,
        description: `احصل على المستندات المؤيدة للبنود التي تتجاوز الأهمية النسبية في ${acct} (${count} بند)، وتحقق من صحتها وتصنيفها وتوقيتها.`,
      };
    case "ROUND_NUMBER":
      return {
        title: `مراجعة المبالغ المدوّرة في ${acct}`,
        description: `تحقق مما إذا كانت المبالغ المدوّرة في ${acct} (${count} قيد) تقديرات أو قيودًا يدوية، وراجع أساس احتسابها واعتمادها.`,
      };
    case "WEEKEND_POSTING":
      return {
        title: `مراجعة قيود نهاية الأسبوع في ${acct}`,
        description: `تحقق من صلاحية توقيت واعتماد القيود المسجَّلة يومَي الجمعة/السبت في ${acct} (${count} قيد).`,
      };
    case "DUPLICATE":
      return {
        title: `فحص ازدواج القيود في ${acct}`,
        description: `تأكد من أن القيود المكرّرة في ${acct} ليست ازدواجًا فعليًا، وصحّح أو وثّق تبريرها.`,
      };
    case "REFERENCE_GAP":
      return {
        title: `فحص اكتمال تسلسل المراجع`,
        description: `تحقق من القيود المفقودة في تسلسل ترقيم المراجع (اختبار اكتمال)، واحصل على تفسير للفجوات.`,
      };
    default:
      return { title: `إجراء تدقيقي — ${riskType}`, description: `راجع الملاحظة ووثّق الاستنتاج.` };
  }
}

/** Suggest procedures for risk flags that don't already have one. */
export function suggestProcedures(companyId: string): ProcedureSuggestion[] {
  const mat = getMateriality(companyId, null);
  const report = analyzeRisk(companyId, mat?.amount ?? null);
  const existing = existingProcedureKeys(companyId);

  // Use the COMPLETE distinct risk keys (uncapped) — not the display flags,
  // which are capped per type for payload/perf. Each key already carries its
  // true total count and highest severity.
  const suggestions: ProcedureSuggestion[] = [];
  for (const g of report.riskKeys) {
    if (g.severity === "INFO") continue; // informational keys don't need a procedure
    const k = keyOf(g.riskType, g.accountCode);
    if (existing.has(k)) continue; // already has a procedure
    const t = template(g.riskType, g.accountCode, g.count);
    suggestions.push({
      riskType: g.riskType, accountCode: g.accountCode, severity: g.severity as ProcedureSeverity,
      title: t.title, description: t.description, flagCount: g.count,
    });
  }
  // order by severity
  suggestions.sort((a, b) => rank(a.severity) - rank(b.severity));
  return suggestions;
}

/** Create procedures for every current suggestion (idempotent: skips existing keys). */
export function generateProcedures(companyId: string, userId: string | null): { created: AuditProcedure[]; skipped: number } {
  const suggestions = suggestProcedures(companyId);
  const created: AuditProcedure[] = [];
  for (const s of suggestions) {
    const proc = createProcedure({
      companyId, riskType: s.riskType, accountCode: s.accountCode, severity: s.severity,
      title: s.title, description: s.description, createdBy: userId,
    });
    created.push(proc);
  }
  writeAuditLog({
    userId, action: "PROCEDURES_GENERATED", entityType: "AuditProcedure", entityId: companyId,
    details: { created: created.length },
  });
  return { created, skipped: 0 };
}

export interface Coverage {
  totalKeys: number;      // distinct high/medium risk keys needing a procedure
  coveredKeys: number;    // those with a DONE/NA procedure
  pct: number;            // 0..100
  openKeys: number;       // needing attention
}

/** How much of the HIGH/MEDIUM assessed risk is covered by a resolved procedure. */
export function computeCoverage(companyId: string): Coverage {
  const mat = getMateriality(companyId, null);
  const report = analyzeRisk(companyId, mat?.amount ?? null);
  const resolved = resolvedProcedureKeys(companyId);

  const keys = new Set<string>();
  for (const g of report.riskKeys) {
    if (g.severity === "HIGH" || g.severity === "MEDIUM") keys.add(keyOf(g.riskType, g.accountCode));
  }
  let covered = 0;
  for (const k of keys) if (resolved.has(k)) covered++;
  const totalKeys = keys.size;
  const pct = totalKeys === 0 ? 100 : Math.round((covered / totalKeys) * 100);
  return { totalKeys, coveredKeys: covered, pct, openKeys: totalKeys - covered };
}

function rank(s: Severity | ProcedureSeverity): number {
  return s === "HIGH" ? 0 : s === "MEDIUM" ? 1 : s === "LOW" ? 2 : s === "MANUAL" ? 3 : 4;
}
