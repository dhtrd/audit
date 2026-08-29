import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, requireAdmin } from "@/lib/auth";
import { listCompanies, getMateriality } from "@/lib/repo";
import { analyzeRisk, type Severity } from "@/lib/risk";
import { saveMateriality, isRiskError } from "@/lib/risk-actions";
import { repairFileName } from "@/lib/upload";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SEV: Record<Severity, { label: string; cls: string }> = {
  HIGH: { label: "مرتفع", cls: "bg-red-100 text-red-700" },
  MEDIUM: { label: "متوسط", cls: "bg-amber-100 text-amber-700" },
  LOW: { label: "منخفض", cls: "bg-blue-100 text-blue-700" },
  INFO: { label: "معلومة", cls: "bg-gray-100 text-gray-600" },
};

export default async function RiskPage({ searchParams }: { searchParams: { companyId?: string; error?: string; ok?: string } }) {
  const session = await requireSession();
  const isAdmin = session.role === "ADMIN";
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const materiality = companyId ? getMateriality(companyId, null) : undefined;
  const report = companyId ? analyzeRisk(companyId, materiality?.amount ?? null) : null;

  async function setMat(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const cid = String(formData.get("companyId") || "");
    const amount = Number(formData.get("amount"));
    const basisNote = String(formData.get("basisNote") || "") || null;
    const r = saveMateriality({ companyId: cid, fiscalYearId: null, amount, basisNote, userId: admin.sub });
    if (isRiskError(r)) redirect(`/risk?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/risk?companyId=${cid}&ok=${encodeURIComponent("تم حفظ الأهمية النسبية")}`);
  }

  const scoreColor = (lvl: Severity) => lvl === "HIGH" ? "text-red-600" : lvl === "MEDIUM" ? "text-amber-600" : "text-emerald-600";

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">المخاطر والإجراءات التحليلية</h1>
      <p className="text-gray-500 text-sm mb-6">
        إجراءات تحليلية محسوبة فعليًا من بيانات الميزان والأستاذ العام المستوردة — تسوية الميزان/الأستاذ،
        البنود الكبيرة، المبالغ المدوّرة، قيود نهاية الأسبوع، المكرّرات، فجوات الترقيم، وقانون بنفورد.
      </p>

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>}

      {companies.length > 1 && (
        <form className="mb-5">
          <label className="block text-xs font-medium text-gray-600 mb-1">الشركة</label>
          <select name="companyId" defaultValue={companyId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
          </select>
          <button className="ms-2 bg-gray-100 border rounded-lg px-3 py-2 text-sm hover:bg-gray-200">عرض</button>
        </form>
      )}

      {!report || !report.hasData ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          لا توجد بيانات مستوردة لهذه الشركة. <Link href="/imports" className="text-navy underline">ابدأ استيرادًا</Link> أولًا.
        </div>
      ) : (
        <>
          {/* Materiality */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
            <h2 className="font-semibold mb-3">الأهمية النسبية (Materiality)</h2>
            {materiality ? (
              <p className="text-sm text-gray-700 mb-3">
                القيمة الحالية: <b>{fmt(materiality.amount)}</b>
                {materiality.basis_note && <span className="text-gray-500"> — الأساس: {materiality.basis_note}</span>}
              </p>
            ) : (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                لم تُحدَّد الأهمية النسبية بعد — فحص &quot;البنود الكبيرة&quot; معطّل حتى تحديدها.
              </p>
            )}
            {isAdmin && (
              <form action={setMat} className="flex items-end gap-3 flex-wrap">
                <input type="hidden" name="companyId" value={companyId} />
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">القيمة</label>
                  <input name="amount" type="number" step="0.01" min="0" required defaultValue={materiality?.amount ?? ""} className="rounded-lg border border-gray-300 px-3 py-2 text-sm w-40" />
                </div>
                <div className="flex-1 min-w-48">
                  <label className="block text-xs font-medium text-gray-600 mb-1">الأساس (اختياري)</label>
                  <input name="basisNote" defaultValue={materiality?.basis_note ?? ""} placeholder="مثال: 1% من إجمالي الأصول" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">حفظ</button>
              </form>
            )}
          </div>

          {/* Overall score */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-sm text-gray-500">درجة المخاطر الإجمالية</div>
                <div className={`text-4xl font-bold mt-1 ${scoreColor(report.riskLevel)}`}>{report.overallScore}<span className="text-lg text-gray-400">/100</span></div>
                <span className={`inline-block mt-2 rounded-full text-xs px-3 py-1 ${SEV[report.riskLevel].cls}`}>مستوى المخاطر: {SEV[report.riskLevel].label}</span>
              </div>
              <div className="text-xs text-gray-400 max-w-xs text-left">
                {report.counts.tbAccounts} حساب ميزان · {report.counts.glEntries} قيد أستاذ عام · {report.riskKeys.length} ملاحظة مميّزة
              </div>
            </div>
            {report.scoreBreakdown.length === 0 ? (
              <p className="text-sm text-emerald-700">لم تُرصد عوامل مخاطر من الإجراءات التحليلية.</p>
            ) : (
              <div className="space-y-2">
                {report.scoreBreakdown.map((b) => (
                  <div key={b.label} className="flex items-center gap-3 text-sm">
                    <span className="inline-block w-10 text-center text-xs rounded bg-red-50 text-red-700 px-1 py-0.5">+{b.points}</span>
                    <span className="text-gray-700">{b.label}</span>
                    <span className="text-gray-400 ms-auto">{b.detail}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Procedures summary */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <ProcCard title="تسوية الميزان ↔ الأستاذ" value={`${report.procedures.reconciliation.mismatchCount} فرق`} sub={`${report.procedures.reconciliation.aboveMaterialityCount} فوق الأهمية`} />
            <ProcCard title="بنود كبيرة" value={report.procedures.largeItems.threshold == null ? "—" : `${report.procedures.largeItems.count}`} sub={report.procedures.largeItems.threshold == null ? "حدّد الأهمية النسبية" : `≥ ${fmt(report.procedures.largeItems.threshold)}`} />
            <ProcCard title="قيود نهاية الأسبوع" value={`${report.procedures.weekendPostings.count}`} sub="الجمعة/السبت" />
            <ProcCard title="قيود مكرّرة" value={`${report.procedures.duplicates.groupCount}`} sub={`${report.procedures.duplicates.count} قيد`} />
            <ProcCard title="مبالغ مدوّرة" value={`${report.procedures.roundNumbers.count}`} sub={`مضاعف ${report.procedures.roundNumbers.threshold}`} />
            <ProcCard title="فجوات الترقيم" value={`${report.procedures.referenceGaps.count}`} sub="أرقام مراجع مفقودة" />
          </div>

          {/* Benford */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
            <h2 className="font-semibold mb-1">قانون بنفورد (الرقم الأول)</h2>
            <p className="text-xs text-gray-500 mb-4">
              العيّنة: {report.procedures.benford.sampleSize} قيدًا
              {report.procedures.benford.mad != null && <> · MAD = {report.procedures.benford.mad}</>} · {report.procedures.benford.verdict}
            </p>
            {report.procedures.benford.digits.length > 0 && (
              <div className="space-y-1">
                {report.procedures.benford.digits.map((d) => {
                  const obsPct = Math.round(d.observed * 1000) / 10;
                  const expPct = Math.round(d.expected * 1000) / 10;
                  return (
                    <div key={d.digit} className="flex items-center gap-2 text-xs">
                      <span className="w-4 font-medium">{d.digit}</span>
                      <div className="flex-1 bg-gray-100 rounded h-4 relative">
                        <div className="bg-navy h-4 rounded" style={{ width: `${Math.min(obsPct * 3, 100)}%` }} />
                        <div className="absolute top-0 h-4 border-l-2 border-red-500" style={{ insetInlineStart: `${Math.min(expPct * 3, 100)}%` }} title={`المتوقع ${expPct}%`} />
                      </div>
                      <span className="w-24 text-gray-500 text-left">{obsPct}% / متوقع {expPct}%</span>
                    </div>
                  );
                })}
                <p className="text-[11px] text-gray-400 mt-2">الأعمدة = الملاحظ فعليًا · الخط الأحمر = المتوقع حسب بنفورد</p>
              </div>
            )}
          </div>

          {/* Risk register */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
            <div className="px-6 py-4 border-b">
              <h2 className="font-semibold">سجل المخاطر ({report.flags.length})</h2>
              {report.flagsTruncated && (
                <p className="text-xs text-amber-700 mt-1">
                  يعرض السجل عيّنة تمثيلية (حتى {report.flagCap} لكل نوع) لأن عدد الملاحظات كبير — الأعداد الإجمالية الصحيحة تظهر في بطاقات الإجراءات أعلاه.
                </p>
              )}
            </div>
            {report.flags.length === 0 ? (
              <p className="px-6 py-6 text-gray-400 text-sm">لا ملاحظات.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="text-right px-4 py-3">الخطورة</th>
                    <th className="text-right px-4 py-3">النوع</th>
                    <th className="text-right px-4 py-3">التفاصيل</th>
                    <th className="text-right px-4 py-3">المصدر</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.flags.map((f, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5"><span className={`inline-block rounded-full text-xs px-2 py-1 ${SEV[f.severity].cls}`}>{SEV[f.severity].label}</span></td>
                      <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{f.title}</td>
                      <td className="px-4 py-2.5 text-gray-700">{f.detail}</td>
                      <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{f.source ? `${repairFileName(f.source.file)}: صف ${f.source.row}` : "—"}</td>
                      <td className="px-4 py-2.5">
                        {f.accountCode && (
                          <Link href={`/trial-balance/${encodeURIComponent(f.accountCode)}?companyId=${companyId}`} className="text-xs text-navy hover:underline whitespace-nowrap">القيود ←</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProcCard({ title, value, sub }: { title: string; value: string; sub: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="text-xs text-gray-400">{title}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </div>
  );
}
