import { redirect } from "next/navigation";
import { requireSession, requireAdmin } from "@/lib/auth";
import { listCompanies } from "@/lib/repo";
import { gatherReportData } from "@/lib/audit-pack";
import { riskTypeLabel } from "@/lib/risk";
import { reportSignatureStatus, signReport, isSignError } from "@/lib/report-signature";
import PrintButton from "./PrintButton";

const fmt = (n: number) => (n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SEV: Record<string, string> = { HIGH: "مرتفع", MEDIUM: "متوسط", LOW: "منخفض", INFO: "معلومة", MANUAL: "يدوي" };
const PST: Record<string, string> = { OPEN: "مفتوح", IN_PROGRESS: "قيد التنفيذ", DONE: "منجز", NA: "لا ينطبق" };
const FST: Record<string, string> = { OPEN: "مفتوحة", RESOLVED: "عولجت", ACCEPTED_RISK: "مخاطرة مقبولة" };
const AST: Record<string, string> = { PROPOSED: "مقترحة", APPROVED: "معتمدة", REJECTED: "مرفوضة" };

export default async function ReportsPage({ searchParams }: { searchParams: { companyId?: string; ok?: string; error?: string } }) {
  const session = await requireSession();
  const isAdmin = session.role === "ADMIN";
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const d = companyId ? gatherReportData(companyId, generatedAt) : null;
  const sig = companyId && d?.company ? reportSignatureStatus(companyId) : null;

  async function sign(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const cid = String(formData.get("companyId") || "");
    const r = signReport({ companyId: cid, note: String(formData.get("note") || "") || null, userId: admin.sub });
    if (isSignError(r)) redirect(`/reports?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/reports?companyId=${cid}&ok=${encodeURIComponent("تم توقيع التقرير")}`);
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4 print:hidden">
        <h1 className="text-2xl font-bold">التقارير والتصدير</h1>
        <div className="flex gap-2">
          {companyId && <a href={`/api/audit-pack?companyId=${companyId}`} className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">تصدير حزمة التدقيق (Excel)</a>}
          <PrintButton />
        </div>
      </div>

      {companies.length > 1 && (
        <form className="mb-5 print:hidden">
          <select name="companyId" defaultValue={companyId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
          </select>
          <button className="ms-2 bg-gray-100 border rounded-lg px-3 py-2 text-sm hover:bg-gray-200">عرض</button>
        </form>
      )}

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 print:hidden">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 print:hidden">{searchParams.ok}</div>}

      {/* Integrity signature panel */}
      {sig && (
        <div className={`mb-5 rounded-xl border p-4 ${!sig.signed ? "bg-gray-50 border-gray-200" : sig.matches ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-300"}`}>
          {!sig.signed ? (
            <div className="text-sm text-gray-600">التقرير غير موقَّع بعد. البصمة الحالية: <code className="text-xs">{sig.currentHash.slice(0, 24)}…</code></div>
          ) : sig.matches ? (
            <div className="text-sm text-emerald-800">
              ✓ التقرير موقَّع والمحتوى مطابق للتوقيع — بواسطة {sig.signerName ?? "—"} في {sig.signedAt}
              <div className="text-xs text-emerald-700 mt-1">البصمة (SHA-256): <code>{sig.signedHash?.slice(0, 24)}…</code>{sig.note ? ` · ${sig.note}` : ""}</div>
            </div>
          ) : (
            <div className="text-sm text-red-800">
              ⚠ تغيّر المحتوى منذ التوقيع الأخير (بواسطة {sig.signerName ?? "—"} في {sig.signedAt}) — يلزم إعادة التوقيع.
              <div className="text-xs text-red-700 mt-1">الموقَّعة: <code>{sig.signedHash?.slice(0, 16)}…</code> · الحالية: <code>{sig.currentHash.slice(0, 16)}…</code></div>
            </div>
          )}
          {isAdmin && (
            <form action={sign} className="flex items-end gap-2 mt-3 print:hidden">
              <input type="hidden" name="companyId" value={companyId} />
              <input name="note" placeholder="ملاحظة (اختياري)" className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm flex-1" />
              <button className="bg-navy text-white rounded-lg px-4 py-1.5 text-sm font-medium hover:opacity-90">{sig.signed ? "إعادة توقيع التقرير" : "توقيع التقرير"}</button>
            </form>
          )}
        </div>
      )}

      {!d || !d.company ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">لا توجد شركة لعرض تقريرها.</div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 print:shadow-none print:border-0 print:p-0 space-y-8">
          {/* Header */}
          <div className="text-center border-b pb-4">
            <div className="text-xl font-bold">حزمة ما قبل التدقيق</div>
            <div className="text-lg mt-1">{d.company.legal_name}{d.company.legal_name_ar ? ` — ${d.company.legal_name_ar}` : ""}</div>
            <div className="text-xs text-gray-500 mt-1">
              {d.company.commercial_registration ? `سجل تجاري: ${d.company.commercial_registration} · ` : ""}
              {d.company.vat_number ? `ضريبي: ${d.company.vat_number} · ` : ""}تاريخ الإصدار: {generatedAt}
            </div>
          </div>

          {/* Readiness */}
          <section>
            <h2 className="font-bold mb-2">مؤشر جاهزية التدقيق: {d.readiness.score}/100 ({d.readiness.level})</h2>
            <table className="w-full text-sm border">
              <thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="text-right px-3 py-2 border">البُعد</th><th className="text-right px-3 py-2 border">النقاط</th><th className="text-right px-3 py-2 border">التفاصيل</th></tr></thead>
              <tbody>{d.readiness.dimensions.map((x) => <tr key={x.key}><td className="px-3 py-1.5 border">{x.label}</td><td className="px-3 py-1.5 border">{x.earned}/{x.weight}</td><td className="px-3 py-1.5 border text-gray-600 text-xs">{x.detail}</td></tr>)}</tbody>
            </table>
          </section>

          {/* Risk summary */}
          <section>
            <h2 className="font-bold mb-2">المخاطر: {d.risk.overallScore}/100 ({d.risk.riskLevel}) — {d.risk.flags.length} ملاحظة</h2>
            <table className="w-full text-sm border">
              <thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="text-right px-3 py-2 border">الخطورة</th><th className="text-right px-3 py-2 border">النوع</th><th className="text-right px-3 py-2 border">التفاصيل</th></tr></thead>
              <tbody>{d.risk.flags.slice(0, 30).map((f, i) => <tr key={i}><td className="px-3 py-1.5 border">{SEV[f.severity]}</td><td className="px-3 py-1.5 border text-xs">{riskTypeLabel(f.type)}</td><td className="px-3 py-1.5 border text-gray-600 text-xs">{f.detail}</td></tr>)}</tbody>
            </table>
            {d.risk.flags.length > 30 && <p className="text-xs text-gray-400 mt-1">عُرضت أول 30 ملاحظة — التفاصيل الكاملة في ملف Excel.</p>}
          </section>

          {/* Procedures */}
          <section>
            <h2 className="font-bold mb-2">الإجراءات ({d.procedures.length})</h2>
            <table className="w-full text-sm border">
              <thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="text-right px-3 py-2 border">الإجراء</th><th className="text-right px-3 py-2 border">الحالة</th><th className="text-right px-3 py-2 border">الأدلة</th></tr></thead>
              <tbody>{d.procedures.map((p) => <tr key={p.id}><td className="px-3 py-1.5 border">{p.title}</td><td className="px-3 py-1.5 border">{PST[p.status]}</td><td className="px-3 py-1.5 border">{p.evidence_count}</td></tr>)}</tbody>
            </table>
          </section>

          {/* Findings */}
          <section>
            <h2 className="font-bold mb-2">الملاحظات ({d.findings.length})</h2>
            {d.findings.length === 0 ? <p className="text-sm text-gray-400">لا ملاحظات.</p> : (
              <table className="w-full text-sm border">
                <thead className="bg-gray-50 text-xs text-gray-500"><tr><th className="text-right px-3 py-2 border">الخطورة</th><th className="text-right px-3 py-2 border">العنوان</th><th className="text-right px-3 py-2 border">الحالة</th><th className="text-right px-3 py-2 border">رد الإدارة</th></tr></thead>
                <tbody>{d.findings.map((f) => <tr key={f.id}><td className="px-3 py-1.5 border">{SEV[f.severity]}</td><td className="px-3 py-1.5 border">{f.title}</td><td className="px-3 py-1.5 border">{FST[f.status]}</td><td className="px-3 py-1.5 border text-gray-600 text-xs">{f.management_response ?? "—"}</td></tr>)}</tbody>
              </table>
            )}
          </section>

          {/* Adjustments */}
          <section>
            <h2 className="font-bold mb-2">التسويات ({d.adjustments.length})</h2>
            {d.adjustments.length === 0 ? <p className="text-sm text-gray-400">لا تسويات.</p> : d.adjustments.map((a) => (
              <div key={a.id} className="mb-3">
                <div className="text-sm font-medium">{a.description} — {AST[a.status]} (مدين {fmt(a.total_debit)} / دائن {fmt(a.total_credit)})</div>
                <table className="w-full text-xs border mt-1">
                  <tbody>{a.lines.map((l) => <tr key={l.id}><td className="px-3 py-1 border">{l.account_code} {l.account_name ? `— ${l.account_name}` : ""}</td><td className="px-3 py-1 border">مدين {fmt(l.debit)}</td><td className="px-3 py-1 border">دائن {fmt(l.credit)}</td></tr>)}</tbody>
                </table>
              </div>
            ))}
          </section>

          {/* Management review */}
          <section>
            <h2 className="font-bold mb-2">مراجعة الإدارة</h2>
            {d.reviews.length === 0 ? <p className="text-sm text-gray-400">لم تُسجَّل مراجعة إدارة.</p> : (
              <ul className="text-sm text-gray-700 space-y-1">
                {d.reviews.slice(0, 5).map((r) => <li key={r.id}>{r.created_at} — {r.decision === "APPROVED" ? "معتمد" : "مُعاد"} بواسطة {r.reviewer_name ?? "—"}{r.notes ? ` · ${r.notes}` : ""}</li>)}
              </ul>
            )}
          </section>

          <div className="text-center text-xs text-gray-400 border-t pt-4">تم إنشاء هذا التقرير آليًا بواسطة PRE-AUDIT OS — يعكس بيانات قاعدة البيانات وقت الإصدار.</div>
        </div>
      )}
    </div>
  );
}
