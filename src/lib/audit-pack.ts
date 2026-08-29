// PRE-AUDIT OS — Phase 6 Audit Pack export.
//
// Consolidates the whole engagement for a company into a real, multi-sheet
// Excel workbook (exceljs) built entirely from the actual database — no
// placeholder rows. Also gathers the same data as a structured object for
// the print-ready HTML report. Every number traces back to Phases 2–5.

import ExcelJS from "exceljs";
import {
  getCompany, listTrialBalances, adjustedTrialBalance, listGeneralLedgerByCompany,
  listProcedures, listFindings, listAdjustments, listAdjustmentLines,
  listManagementReviews, getMateriality, listAuditLogs,
} from "./repo";
import { analyzeRisk, riskTypeLabel } from "./risk";
import { computeFullReadiness } from "./readiness2";

const money = (n: number) => Math.round((n ?? 0) * 100) / 100;

export interface ReportData {
  company: ReturnType<typeof getCompany>;
  generatedAt: string;
  readiness: ReturnType<typeof computeFullReadiness>;
  materiality: number | null;
  risk: ReturnType<typeof analyzeRisk>;
  trialBalance: ReturnType<typeof listTrialBalances>;
  adjustedTB: ReturnType<typeof adjustedTrialBalance>;
  procedures: ReturnType<typeof listProcedures>;
  findings: ReturnType<typeof listFindings>;
  adjustments: (ReturnType<typeof listAdjustments>[number] & { lines: ReturnType<typeof listAdjustmentLines> })[];
  reviews: ReturnType<typeof listManagementReviews>;
}

export function gatherReportData(companyId: string, generatedAt: string): ReportData {
  const mat = getMateriality(companyId, null);
  return {
    company: getCompany(companyId),
    generatedAt,
    readiness: computeFullReadiness(companyId),
    materiality: mat?.amount ?? null,
    risk: analyzeRisk(companyId, mat?.amount ?? null),
    trialBalance: listTrialBalances(companyId),
    adjustedTB: adjustedTrialBalance(companyId),
    procedures: listProcedures(companyId),
    findings: listFindings(companyId),
    adjustments: listAdjustments(companyId).map((a) => ({ ...a, lines: listAdjustmentLines(a.id) })),
    reviews: listManagementReviews(companyId),
  };
}

const SEV_AR: Record<string, string> = { HIGH: "مرتفع", MEDIUM: "متوسط", LOW: "منخفض", INFO: "معلومة", MANUAL: "يدوي" };
const PST_AR: Record<string, string> = { OPEN: "مفتوح", IN_PROGRESS: "قيد التنفيذ", DONE: "منجز", NA: "لا ينطبق" };
const FST_AR: Record<string, string> = { OPEN: "مفتوحة", RESOLVED: "عولجت", ACCEPTED_RISK: "مخاطرة مقبولة" };
const AST_AR: Record<string, string> = { PROPOSED: "مقترحة", APPROVED: "معتمدة", REJECTED: "مرفوضة" };

export async function buildAuditPackWorkbook(companyId: string, generatedAt: string): Promise<ExcelJS.Workbook> {
  const d = gatherReportData(companyId, generatedAt);
  const wb = new ExcelJS.Workbook();
  wb.creator = "PRE-AUDIT OS";
  wb.created = new Date(0); // deterministic; overwritten by generatedAt in the summary

  const addSheet = (name: string) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true }] });
    return ws;
  };
  const headerRow = (ws: ExcelJS.Worksheet, cols: string[]) => {
    const r = ws.addRow(cols);
    r.font = { bold: true };
    r.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } }; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; });
  };

  // 1) Summary + readiness
  {
    const ws = addSheet("الملخص");
    ws.columns = [{ width: 32 }, { width: 40 }];
    ws.addRow(["حزمة ما قبل التدقيق — PRE-AUDIT OS"]).font = { bold: true, size: 14 };
    ws.addRow(["الشركة", d.company?.legal_name ?? ""]);
    ws.addRow(["الاسم بالعربية", d.company?.legal_name_ar ?? ""]);
    ws.addRow(["السجل التجاري", d.company?.commercial_registration ?? ""]);
    ws.addRow(["الرقم الضريبي", d.company?.vat_number ?? ""]);
    ws.addRow(["تاريخ الإصدار", generatedAt]);
    ws.addRow(["الأهمية النسبية", d.materiality != null ? money(d.materiality) : "غير محددة"]);
    ws.addRow([]);
    ws.addRow(["مؤشر جاهزية التدقيق", `${d.readiness.score}/100 (${d.readiness.level})`]).font = { bold: true };
    ws.addRow([]);
    headerRow(ws, ["البُعد", "النقاط", "التفاصيل"]);
    ws.columns = [{ width: 34 }, { width: 12 }, { width: 60 }];
    for (const dim of d.readiness.dimensions) ws.addRow([dim.label, `${dim.earned}/${dim.weight}`, dim.detail]);
  }

  // 2) Trial balance
  {
    const ws = addSheet("ميزان المراجعة");
    headerRow(ws, ["رمز الحساب", "اسم الحساب", "افتتاحي", "مدين", "دائن", "ختامي", "المصدر", "صف"]);
    ws.columns = [{ width: 14 }, { width: 28 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 20 }, { width: 8 }];
    for (const r of d.trialBalance) ws.addRow([r.account_code, r.account_name, money(r.opening_balance), money(r.debit), money(r.credit), money(r.closing_balance), r.source_file, r.source_row]);
  }

  // 3) Adjusted trial balance
  {
    const ws = addSheet("الميزان المعدّل");
    headerRow(ws, ["رمز الحساب", "اسم الحساب", "صافي الميزان", "تسوية مدين", "تسوية دائن", "الصافي المعدّل"]);
    ws.columns = [{ width: 14 }, { width: 28 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 16 }];
    for (const r of d.adjustedTB) ws.addRow([r.account_code, r.account_name, money(r.tb_debit - r.tb_credit), money(r.adj_debit), money(r.adj_credit), money(r.adjusted_net)]);
  }

  // 4) General ledger
  {
    const ws = addSheet("الأستاذ العام");
    headerRow(ws, ["التاريخ", "اليومية", "رمز الحساب", "اسم الحساب", "الطرف", "المرجع", "البيان", "مدين", "دائن", "المصدر", "صف"]);
    ws.columns = [{ width: 12 }, { width: 12 }, { width: 12 }, { width: 24 }, { width: 16 }, { width: 12 }, { width: 24 }, { width: 12 }, { width: 12 }, { width: 18 }, { width: 8 }];
    for (const r of listGeneralLedgerByCompany(companyId)) ws.addRow([r.entry_date, r.journal, r.account_code, r.account_name, r.partner, r.reference, r.description, money(r.debit), money(r.credit), r.source_file, r.source_row]);
  }

  // 5) Risk register
  {
    const ws = addSheet("سجل المخاطر");
    ws.addRow([`درجة المخاطر: ${d.risk.overallScore}/100 (${d.risk.riskLevel})`]).font = { bold: true };
    headerRow(ws, ["الخطورة", "النوع", "الحساب", "التفاصيل", "المصدر"]);
    ws.columns = [{ width: 10 }, { width: 18 }, { width: 12 }, { width: 60 }, { width: 20 }];
    for (const f of d.risk.flags) ws.addRow([SEV_AR[f.severity] ?? f.severity, riskTypeLabel(f.type), f.accountCode ?? "", f.detail, f.source ? `${f.source.file}:${f.source.row}` : ""]);
  }

  // 6) Procedures
  {
    const ws = addSheet("الإجراءات");
    headerRow(ws, ["الخطورة", "الإجراء", "الحساب", "الحالة", "الاستنتاج", "عدد الأدلة"]);
    ws.columns = [{ width: 10 }, { width: 44 }, { width: 12 }, { width: 14 }, { width: 40 }, { width: 10 }];
    for (const p of d.procedures) ws.addRow([SEV_AR[p.severity] ?? p.severity, p.title, p.account_code ?? "", PST_AR[p.status] ?? p.status, p.conclusion ?? "", p.evidence_count]);
  }

  // 7) Findings
  {
    const ws = addSheet("الملاحظات");
    headerRow(ws, ["الخطورة", "العنوان", "الحساب", "الحالة", "التوصية", "رد الإدارة"]);
    ws.columns = [{ width: 10 }, { width: 36 }, { width: 12 }, { width: 16 }, { width: 36 }, { width: 36 }];
    for (const f of d.findings) ws.addRow([SEV_AR[f.severity] ?? f.severity, f.title, f.account_code ?? "", FST_AR[f.status] ?? f.status, f.recommendation ?? "", f.management_response ?? ""]);
  }

  // 8) Adjustments (with lines)
  {
    const ws = addSheet("التسويات");
    headerRow(ws, ["الوصف", "الحالة", "رمز الحساب", "اسم الحساب", "مدين", "دائن"]);
    ws.columns = [{ width: 30 }, { width: 12 }, { width: 14 }, { width: 24 }, { width: 14 }, { width: 14 }];
    for (const a of d.adjustments) {
      for (const l of a.lines) ws.addRow([a.description, AST_AR[a.status] ?? a.status, l.account_code, l.account_name, money(l.debit), money(l.credit)]);
    }
  }

  // 9) Audit trail (recent)
  {
    const ws = addSheet("سجل التدقيق");
    headerRow(ws, ["التاريخ", "المستخدم", "العملية", "الكيان", "التفاصيل"]);
    ws.columns = [{ width: 20 }, { width: 18 }, { width: 20 }, { width: 18 }, { width: 50 }];
    for (const l of listAuditLogs(500)) ws.addRow([l.created_at, l.user_name ?? "", l.action, l.entity_type, l.details ?? ""]);
  }

  return wb;
}
