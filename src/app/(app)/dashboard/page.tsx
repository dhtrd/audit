import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, requireAdmin } from "@/lib/auth";
import { listCompanies, listFiscalYears, latestManagementReview } from "@/lib/repo";
import { computeFullReadiness } from "@/lib/readiness2";
import { submitManagementReview, isP5Error } from "@/lib/phase5-actions";

export default async function DashboardPage({ searchParams }: { searchParams: { companyId?: string; error?: string; ok?: string } }) {
  const session = await requireSession();
  const isAdmin = session.role === "ADMIN";
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const readiness = companyId ? computeFullReadiness(companyId) : null;
  const review = companyId ? latestManagementReview(companyId) : undefined;
  const fyCount = companyId ? listFiscalYears(companyId).length : 0;

  async function submitReview(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const cid = String(formData.get("companyId") || "");
    const r = submitManagementReview({
      companyId: cid, decision: (String(formData.get("decision")) as any),
      notes: String(formData.get("notes") || "") || null, userId: admin.sub,
    });
    if (isP5Error(r)) redirect(`/dashboard?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/dashboard?companyId=${cid}&ok=${encodeURIComponent("تم تسجيل قرار مراجعة الإدارة")}`);
  }

  const scoreColor = (lvl: string) => lvl === "HIGH" ? "text-emerald-600" : lvl === "MEDIUM" ? "text-amber-600" : "text-red-600";
  const levelLabel = (lvl: string) => lvl === "HIGH" ? "جاهز" : lvl === "MEDIUM" ? "شبه جاهز" : "غير جاهز";

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">لوحة التحكم</h1>
      <p className="text-gray-500 text-sm mb-6">مؤشر جاهزية التدقيق الكامل محسوب من كل مراحل النظام (البيانات، المخاطر، الإجراءات، الأدلة، الملاحظات، التسويات، مراجعة الإدارة).</p>

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>}

      {companies.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          لا توجد شركات بعد. <Link href="/company" className="text-navy underline">أضِف شركة</Link> للبدء.
        </div>
      ) : (
        <>
          {companies.length > 1 && (
            <form className="mb-5">
              <select name="companyId" defaultValue={companyId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
              </select>
              <button className="ms-2 bg-gray-100 border rounded-lg px-3 py-2 text-sm hover:bg-gray-200">عرض</button>
            </form>
          )}

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="text-sm text-gray-500">مؤشر جاهزية التدقيق (Audit Readiness Score)</div>
                <div className={`text-5xl font-bold mt-1 ${scoreColor(readiness!.level)}`}>{readiness!.score}<span className="text-xl text-gray-400">/100</span></div>
                <span className={`inline-block mt-2 rounded-full text-xs px-3 py-1 ${readiness!.level === "HIGH" ? "bg-emerald-100 text-emerald-700" : readiness!.level === "MEDIUM" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}>{levelLabel(readiness!.level)}</span>
              </div>
              {!readiness!.hasData && <div className="text-xs text-gray-400 max-w-xs text-left">لا توجد بيانات مستوردة بعد — المؤشر 0 حتى استيراد الميزان/الأستاذ.</div>}
            </div>
            <div className="space-y-2.5">
              {readiness!.dimensions.map((d) => {
                const pct = d.weight === 0 ? 0 : Math.round((d.earned / d.weight) * 100);
                return (
                  <div key={d.key} className="text-sm">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-gray-700">{d.label}</span>
                      <span className="text-gray-400 text-xs">{d.earned}/{d.weight}</span>
                    </div>
                    <div className="bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div className={`h-2 rounded-full ${pct >= 80 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-400"}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{d.detail}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 mb-6">
            <Link href="/company" className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:border-navy transition"><div className="text-3xl font-bold">{companies.length}</div><div className="text-sm text-gray-500 mt-1">الشركات</div></Link>
            <Link href="/fiscal-years" className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:border-navy transition"><div className="text-3xl font-bold">{fyCount}</div><div className="text-sm text-gray-500 mt-1">السنوات المالية</div></Link>
            <Link href="/risk" className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:border-navy transition"><div className="text-sm text-gray-500 mt-1">المخاطر والتحليلات ←</div></Link>
          </div>

          {/* Management review */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="font-semibold mb-3">مراجعة الإدارة</h2>
            {review ? (
              <p className="text-sm text-gray-700 mb-3">آخر قرار: <b className={review.decision === "APPROVED" ? "text-emerald-600" : "text-amber-600"}>{review.decision === "APPROVED" ? "معتمد" : "مُعاد للمراجعة"}</b>
                {" "}بواسطة {review.reviewer_name ?? "—"} — {review.created_at}{review.notes ? ` · ${review.notes}` : ""}</p>
            ) : <p className="text-sm text-gray-400 mb-3">لم تُسجَّل مراجعة إدارة بعد.</p>}
            {isAdmin && (
              <form action={submitReview} className="flex items-end gap-3 flex-wrap">
                <input type="hidden" name="companyId" value={companyId} />
                <div>
                  <label className="block text-xs text-gray-500 mb-1">القرار</label>
                  <select name="decision" className="rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="APPROVED">اعتماد</option><option value="RETURNED">إعادة للمراجعة</option></select>
                </div>
                <div className="flex-1 min-w-56"><label className="block text-xs text-gray-500 mb-1">ملاحظات</label><input name="notes" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
                <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">تسجيل القرار</button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
