import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, requireExecutor, canExecute } from "@/lib/auth";
import { listCompanies, listProcedures, procedureStatusCounts } from "@/lib/repo";
import { suggestProcedures, computeCoverage, generateProcedures } from "@/lib/procedures";
import { createManualProcedure, isProcError } from "@/lib/procedure-actions";

const SEV: Record<string, { label: string; cls: string }> = {
  HIGH: { label: "مرتفع", cls: "bg-red-100 text-red-700" },
  MEDIUM: { label: "متوسط", cls: "bg-amber-100 text-amber-700" },
  LOW: { label: "منخفض", cls: "bg-blue-100 text-blue-700" },
  INFO: { label: "معلومة", cls: "bg-gray-100 text-gray-600" },
  MANUAL: { label: "يدوي", cls: "bg-purple-100 text-purple-700" },
};
const STATUS: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "مفتوح", cls: "bg-gray-100 text-gray-600" },
  IN_PROGRESS: { label: "قيد التنفيذ", cls: "bg-amber-100 text-amber-700" },
  DONE: { label: "منجز ✓", cls: "bg-emerald-100 text-emerald-700" },
  NA: { label: "لا ينطبق", cls: "bg-gray-100 text-gray-500" },
};

export default async function ProceduresPage({ searchParams }: { searchParams: { companyId?: string; error?: string; ok?: string } }) {
  const session = await requireSession();
  const isAdmin = canExecute(session.role);
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const procedures = companyId ? listProcedures(companyId) : [];
  const counts = companyId ? procedureStatusCounts(companyId) : { OPEN: 0, IN_PROGRESS: 0, DONE: 0, NA: 0 };
  const coverage = companyId ? computeCoverage(companyId) : { totalKeys: 0, coveredKeys: 0, pct: 100, openKeys: 0 };
  const suggestionCount = companyId ? suggestProcedures(companyId).length : 0;

  async function generate(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const cid = String(formData.get("companyId") || "");
    const res = generateProcedures(cid, admin.sub);
    redirect(`/procedures?companyId=${cid}&ok=${encodeURIComponent(`تم توليد ${res.created.length} إجراء من المخاطر`)}`);
  }
  async function addManual(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const cid = String(formData.get("companyId") || "");
    const title = String(formData.get("title") || "");
    const description = String(formData.get("description") || "") || null;
    const accountCode = String(formData.get("accountCode") || "") || null;
    const r = createManualProcedure({ companyId: cid, title, description, accountCode, userId: admin.sub });
    if (isProcError(r)) redirect(`/procedures?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/procedures?companyId=${cid}&ok=${encodeURIComponent("تمت إضافة الإجراء")}`);
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">الأدلة والإجراءات التدقيقية</h1>
      <p className="text-gray-500 text-sm mb-6">
        إجراءات تدقيق مُولَّدة من ملاحظات المخاطر، مع تتبّع الحالة والاستنتاج وإرفاق الأدلة، وقياس نسبة تغطية المخاطر.
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

      {/* Coverage + status summary */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="text-xs text-gray-400">تغطية المخاطر (عالية/متوسطة)</div>
          <div className={`text-3xl font-bold mt-1 ${coverage.pct >= 80 ? "text-emerald-600" : coverage.pct >= 40 ? "text-amber-600" : "text-red-600"}`}>{coverage.pct}%</div>
          <div className="text-xs text-gray-500 mt-0.5">{coverage.coveredKeys} من {coverage.totalKeys} مُعالَجة</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="text-xs text-gray-400">مفتوح / قيد التنفيذ</div>
          <div className="text-3xl font-bold mt-1">{counts.OPEN + counts.IN_PROGRESS}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="text-xs text-gray-400">منجز</div>
          <div className="text-3xl font-bold mt-1 text-emerald-600">{counts.DONE}</div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="text-xs text-gray-400">اقتراحات جديدة من المخاطر</div>
          <div className="text-3xl font-bold mt-1">{suggestionCount}</div>
        </div>
      </div>

      {isAdmin && (
        <div className="flex flex-wrap gap-4 mb-6">
          <form action={generate}>
            <input type="hidden" name="companyId" value={companyId} />
            <button disabled={suggestionCount === 0} className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
              توليد الإجراءات من المخاطر ({suggestionCount})
            </button>
          </form>
        </div>
      )}

      {/* Procedures table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-right px-4 py-3">الخطورة</th>
              <th className="text-right px-4 py-3">الإجراء</th>
              <th className="text-right px-4 py-3">الحساب</th>
              <th className="text-right px-4 py-3">الحالة</th>
              <th className="text-right px-4 py-3">الأدلة</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {procedures.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-gray-400 text-center">لا توجد إجراءات بعد — استخدم &quot;توليد الإجراءات من المخاطر&quot;.</td></tr>
            )}
            {procedures.map((p) => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="px-4 py-2.5"><span className={`inline-block rounded-full text-xs px-2 py-1 ${SEV[p.severity]?.cls}`}>{SEV[p.severity]?.label}</span></td>
                <td className="px-4 py-2.5 text-gray-700">{p.title}</td>
                <td className="px-4 py-2.5 text-gray-500">{p.account_code ?? "—"}</td>
                <td className="px-4 py-2.5"><span className={`inline-block rounded-full text-xs px-2 py-1 ${STATUS[p.status]?.cls}`}>{STATUS[p.status]?.label}</span></td>
                <td className="px-4 py-2.5 text-gray-600">{p.evidence_count}</td>
                <td className="px-4 py-2.5"><Link href={`/procedures/${p.id}`} className="text-xs text-navy hover:underline">فتح</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && companyId && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold mb-4">إضافة إجراء يدوي</h2>
          <form action={addManual} className="grid grid-cols-2 gap-4">
            <input type="hidden" name="companyId" value={companyId} />
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">العنوان</label>
              <input name="title" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">الوصف</label>
              <textarea name="description" rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">رمز الحساب (اختياري)</label>
              <input name="accountCode" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2">
              <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">حفظ</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
