// PRE-AUDIT OS — Full Audit Readiness Score (spec section 8).
//
// Now that Phases 2–5 exist, this computes the REAL weighted readiness
// score across every dimension the spec listed — data quality,
// reconciliation, risk assessment, procedure coverage, evidence,
// findings resolution, adjustments, and management review — each measured
// from actual database state, with a transparent breakdown. Nothing here
// is invented: every sub-score cites the real numbers behind it.

import {
  committedBatchStats, proceduresWithEvidenceStats, findingStatusCounts,
  adjustmentStatusCounts, latestManagementReview, getMateriality,
  trialBalanceMovementByAccount,
} from "./repo";
import { analyzeRisk } from "./risk";
import { computeCoverage } from "./procedures";

export interface ReadinessDimension {
  key: string;
  label: string;
  weight: number;      // max points
  earned: number;      // 0..weight
  detail: string;
}

export interface FullReadiness {
  score: number;             // 0..100
  level: "HIGH" | "MEDIUM" | "LOW";  // readiness level (HIGH = ready)
  dimensions: ReadinessDimension[];
  hasData: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeFullReadiness(companyId: string): FullReadiness {
  const batch = committedBatchStats(companyId);
  const hasData = batch.committed > 0;

  const dims: ReadinessDimension[] = [];

  // 1. Data imported & quality (20) — TB + GL committed, avg quality, no BLOCKED
  {
    const weight = 20;
    let earned = 0;
    const hasTB = batch.hasTB > 0, hasGL = batch.hasGL > 0;
    if (hasTB) earned += 6;
    if (hasGL) earned += 6;
    earned += Math.round((batch.avgQuality / 100) * 8); // up to 8 from quality
    if (batch.blocked > 0) earned = Math.max(0, earned - 6); // unresolved blocked import penalises
    earned = Math.min(weight, earned);
    dims.push({ key: "data", label: "استيراد البيانات وجودتها", weight, earned,
      detail: `ميزان: ${hasTB ? "نعم" : "لا"} · أستاذ عام: ${hasGL ? "نعم" : "لا"} · متوسط الجودة ${batch.avgQuality}%${batch.blocked ? ` · محظور ${batch.blocked}` : ""}` });
  }

  // 2. Reconciliation (15) — TB balanced (8) + TB↔GL reconciliation (7).
  // The TB↔GL part is only creditable when GL data actually exists —
  // otherwise it is "not assessable", not "passed".
  {
    const weight = 15;
    const tb = trialBalanceMovementByAccount(companyId);
    const totD = round2(tb.reduce((s, a) => s + a.debit, 0));
    const totC = round2(tb.reduce((s, a) => s + a.credit, 0));
    const balanced = tb.length > 0 && Math.abs(totD - totC) <= 0.005;
    const mat = getMateriality(companyId, null);
    const risk = analyzeRisk(companyId, mat?.amount ?? null);
    const mism = risk.procedures.reconciliation.mismatchCount;
    const hasGL = batch.hasGL > 0;
    let earned = 0;
    if (balanced) earned += 8;
    if (hasGL) earned += mism === 0 ? 7 : Math.max(0, 7 - mism); // TB↔GL only if GL exists
    earned = Math.min(weight, earned);
    dims.push({ key: "reconciliation", label: "التسوية (توازن الميزان + الميزان/الأستاذ)", weight, earned,
      detail: hasGL ? `${balanced ? "الميزان متوازن" : "الميزان غير متوازن"} · فروقات ميزان/أستاذ: ${mism}`
                    : `${balanced ? "الميزان متوازن" : "الميزان غير متوازن"} · لم يُستورد أستاذ عام للتسوية` });
  }

  // 3. Risk assessment (10) — materiality set + analysis available
  {
    const weight = 10;
    const mat = getMateriality(companyId, null);
    let earned = 0;
    if (mat) earned += 6;
    if (hasData) earned += 4; // analysis runs on real data
    earned = Math.min(weight, earned);
    dims.push({ key: "risk", label: "تقييم المخاطر", weight, earned,
      detail: `${mat ? `الأهمية النسبية محددة (${round2(mat.amount)})` : "الأهمية النسبية غير محددة"}` });
  }

  // 4. Procedure coverage (20) — Phase 4 coverage %. Risk must be
  // assessable first (GL imported + materiality set); otherwise "100%
  // coverage of zero detected risks" would falsely inflate the score, so
  // it counts as not-assessed (0).
  {
    const weight = 20;
    const mat = getMateriality(companyId, null);
    const assessable = batch.hasGL > 0 && !!mat;
    const cov = computeCoverage(companyId);
    const earned = assessable ? Math.round((cov.pct / 100) * weight) : 0;
    dims.push({ key: "coverage", label: "تغطية المخاطر بالإجراءات", weight, earned,
      detail: assessable
        ? `${cov.pct}% (${cov.coveredKeys}/${cov.totalKeys} ملاحظة عالية/متوسطة مُعالَجة)`
        : "غير مُقيَّمة — يلزم استيراد الأستاذ العام وتحديد الأهمية النسبية" });
  }

  // 5. Evidence (10) — DONE procedures that have evidence
  {
    const weight = 10;
    const ev = proceduresWithEvidenceStats(companyId);
    const pct = ev.done === 0 ? 0 : ev.doneWithEvidence / ev.done;
    const earned = ev.done === 0 ? 0 : Math.round(pct * weight);
    dims.push({ key: "evidence", label: "الأدلة المرفقة بالإجراءات المنجزة", weight, earned,
      detail: ev.done === 0 ? "لا إجراءات منجزة بعد" : `${ev.doneWithEvidence}/${ev.done} إجراء منجز لديه دليل` });
  }

  // 6. Findings resolution (15)
  {
    const weight = 15;
    const fc = findingStatusCounts(companyId);
    const total = fc.OPEN + fc.RESOLVED + fc.ACCEPTED_RISK;
    const addressed = fc.RESOLVED + fc.ACCEPTED_RISK;
    const earned = total === 0 ? weight : Math.round((addressed / total) * weight);
    dims.push({ key: "findings", label: "معالجة الملاحظات", weight, earned,
      detail: total === 0 ? "لا ملاحظات مسجّلة" : `${addressed}/${total} ملاحظة عولجت (مفتوحة: ${fc.OPEN})` });
  }

  // 7. Adjustments (5) — proposed adjustments decided (approved/rejected, none left pending)
  {
    const weight = 5;
    const ac = adjustmentStatusCounts(companyId);
    const total = ac.PROPOSED + ac.APPROVED + ac.REJECTED;
    const decided = ac.APPROVED + ac.REJECTED;
    const earned = total === 0 ? weight : Math.round((decided / total) * weight);
    dims.push({ key: "adjustments", label: "بتّ قيود التسوية", weight, earned,
      detail: total === 0 ? "لا تسويات مقترحة" : `${decided}/${total} تسوية تم بتّها (معلّقة: ${ac.PROPOSED})` });
  }

  // 8. Management review (5)
  {
    const weight = 5;
    const mr = latestManagementReview(companyId);
    const earned = mr && mr.decision === "APPROVED" ? weight : 0;
    dims.push({ key: "review", label: "مراجعة الإدارة", weight, earned,
      detail: mr ? `آخر قرار: ${mr.decision === "APPROVED" ? "معتمد" : "مُعاد"}` : "لم تُجرَ مراجعة الإدارة بعد" });
  }

  const score = hasData ? Math.min(100, dims.reduce((s, d) => s + d.earned, 0)) : 0;
  const level: FullReadiness["level"] = score >= 80 ? "HIGH" : score >= 50 ? "MEDIUM" : "LOW";
  return { score, level, dimensions: dims, hasData };
}
