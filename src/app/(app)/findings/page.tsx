import { redirect } from "next/navigation";
import { requireSession, requireExecutor, canExecute } from "@/lib/auth";
import { listCompanies, listFindings, findingStatusCounts, listProcedures } from "@/lib/repo";
import { raiseFinding, updateFindingAction, isP5Error } from "@/lib/phase5-actions";

const SEV: Record<string, { label: string; cls: string }> = {
  HIGH: { label: "مرتفع", cls: "bg-red-100 text-red-700" },
  MEDIUM: { label: "متوسط", cls: "bg-amber-100 text-amber-700" },
  LOW: { label: "منخفض", cls: "bg-blue-100 text-blue-700" },
};
const ST: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "مفتوحة", cls: "bg-gray-100 text-gray-600" },
  RESOLVED: { label: "عولجت ✓", cls: "bg-emerald-100 text-emerald-700" },
  ACCEPTED_RISK: { label: "مخاطرة مقبولة", cls: "bg-purple-100 text-purple-700" },
};

export default async function FindingsPage({ searchParams }: { searchParams: { companyId?: string; error?: string; ok?: string } }) {
  const session = await requireSession();
  const isAdmin = canExecute(session.role);
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const findings = companyId ? listFindings(companyId) : [];
  const counts = companyId ? findingStatusCounts(companyId) : { OPEN: 0, RESOLVED: 0, ACCEPTED_RISK: 0 };
  const procedures = companyId ? listProcedures(companyId) : [];

  async function raise(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const cid = String(formData.get("companyId") || "");
    const r = raiseFinding({
      companyId: cid, title: String(formData.get("title") || ""),
      description: String(formData.get("description") || "") || null,
      severity: (String(formData.get("severity") || "MEDIUM") as any),
      procedureId: String(formData.get("procedureId") || "") || null,
      accountCode: String(formData.get("accountCode") || "") || null,
      recommendation: String(formData.get("recommendation") || "") || null,
      userId: admin.sub,
    });
    if (isP5Error(r)) redirect(`/findings?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/findings?companyId=${cid}&ok=${encodeURIComponent("تم تسجيل الملاحظة")}`);
  }
  async function update(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const cid = String(formData.get("companyId") || "");
    const r = updateFindingAction({
      findingId: String(formData.get("findingId") || ""),
      status: (String(formData.get("status") || "OPEN") as any),
      managementResponse: String(formData.get("managementResponse") || "") || null,
      userId: admin.sub,
    });
    if (isP5Error(r)) redirect(`/findings?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/findings?companyId=${cid}&ok=${encodeURIComponent("تم تحديث الملاحظة")}`);
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">الملاحظات</h1>
      <p className="text-gray-500 text-sm mb-6">ملاحظات التدقيق المرفوعة من الإجراءات أو يدويًا، مع رد الإدارة وحالة المعالجة.</p>

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>}

      {companies.length > 1 && (
        <form className="mb-5">
          <select name="companyId" defaultValue={companyId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
          </select>
          <button className="ms-2 bg-gray-100 border rounded-lg px-3 py-2 text-sm hover:bg-gray-200">عرض</button>
        </form>
      )}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">مفتوحة</div><div className="text-3xl font-bold mt-1 text-amber-600">{counts.OPEN}</div></div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">عولجت</div><div className="text-3xl font-bold mt-1 text-emerald-600">{counts.RESOLVED}</div></div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">مخاطرة مقبولة</div><div className="text-3xl font-bold mt-1">{counts.ACCEPTED_RISK}</div></div>
      </div>

      <div className="space-y-3 mb-8">
        {findings.length === 0 && <div className="bg-white rounded-xl border border-gray-100 p-6 text-center text-gray-400 text-sm">لا ملاحظات بعد.</div>}
        {findings.map((f) => (
          <div key={f.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-3 mb-1">
              <span className={`inline-block rounded-full text-xs px-2 py-1 ${SEV[f.severity]?.cls}`}>{SEV[f.severity]?.label}</span>
              <span className="font-semibold">{f.title}</span>
              <span className={`inline-block rounded-full text-xs px-2 py-1 ${ST[f.status]?.cls}`}>{ST[f.status]?.label}</span>
              {f.account_code && <span className="text-xs text-gray-400">حساب {f.account_code}</span>}
              {f.adjustment_count > 0 && <span className="text-xs text-gray-400 ms-auto">{f.adjustment_count} تسوية مرتبطة</span>}
            </div>
            {f.description && <p className="text-sm text-gray-600 mb-1">{f.description}</p>}
            {f.recommendation && <p className="text-sm text-gray-500 mb-1">التوصية: {f.recommendation}</p>}
            {f.management_response && <p className="text-sm text-gray-500 mb-1">رد الإدارة: {f.management_response}</p>}
            {isAdmin && (
              <form action={update} className="flex items-end gap-2 mt-3 pt-3 border-t flex-wrap">
                <input type="hidden" name="companyId" value={companyId} />
                <input type="hidden" name="findingId" value={f.id} />
                <div>
                  <label className="block text-xs text-gray-500 mb-1">الحالة</label>
                  <select name="status" defaultValue={f.status} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                    {Object.entries(ST).map(([v, s]) => <option key={v} value={v}>{s.label}</option>)}
                  </select>
                </div>
                <div className="flex-1 min-w-56">
                  <label className="block text-xs text-gray-500 mb-1">رد الإدارة</label>
                  <input name="managementResponse" defaultValue={f.management_response ?? ""} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                </div>
                <button className="bg-gray-800 text-white rounded-lg px-3 py-1.5 text-sm hover:opacity-90">حفظ</button>
              </form>
            )}
          </div>
        ))}
      </div>

      {isAdmin && companyId && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold mb-4">رفع ملاحظة</h2>
          <form action={raise} className="grid grid-cols-2 gap-4">
            <input type="hidden" name="companyId" value={companyId} />
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">العنوان</label>
              <input name="title" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">الخطورة</label>
              <select name="severity" defaultValue="MEDIUM" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="HIGH">مرتفع</option><option value="MEDIUM">متوسط</option><option value="LOW">منخفض</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">مرتبطة بإجراء (اختياري)</label>
              <select name="procedureId" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">—</option>
                {procedures.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">رمز الحساب (اختياري)</label>
              <input name="accountCode" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">الوصف</label>
              <textarea name="description" rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">التوصية</label>
              <input name="recommendation" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2"><button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">حفظ الملاحظة</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
