import { redirect } from "next/navigation";
import { requireSession, requireAdmin, requireExecutor, canExecute } from "@/lib/auth";
import {
  listCompanies, listAdjustments, listAdjustmentLines, adjustmentStatusCounts,
  adjustedTrialBalance, listFindings,
} from "@/lib/repo";
import { proposeAdjustment, decideAdjustment, isP5Error, type AdjLineInput } from "@/lib/phase5-actions";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AST: Record<string, { label: string; cls: string }> = {
  PROPOSED: { label: "مقترحة", cls: "bg-amber-100 text-amber-700" },
  APPROVED: { label: "معتمدة ✓", cls: "bg-emerald-100 text-emerald-700" },
  REJECTED: { label: "مرفوضة", cls: "bg-red-100 text-red-700" },
};
const LINE_ROWS = 4;

export default async function AdjustmentsPage({ searchParams }: { searchParams: { companyId?: string; error?: string; ok?: string } }) {
  const session = await requireSession();
  const isAdmin = session.role === "ADMIN";     // approve/reject (separation of duties)
  const canWrite = canExecute(session.role);    // propose adjustment (ADMIN or EXECUTOR)
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const adjustments = companyId ? listAdjustments(companyId).map((a) => ({ ...a, lines: listAdjustmentLines(a.id) })) : [];
  const counts = companyId ? adjustmentStatusCounts(companyId) : { PROPOSED: 0, APPROVED: 0, REJECTED: 0 };
  const findings = companyId ? listFindings(companyId) : [];
  const adjTB = companyId ? adjustedTrialBalance(companyId) : [];
  const hasAdjustments = adjTB.some((r) => r.adj_debit !== 0 || r.adj_credit !== 0);
  const tbTotals = adjTB.reduce((t, r) => ({ net: t.net + (r.tb_debit - r.tb_credit), adjNet: t.adjNet + r.adjusted_net }), { net: 0, adjNet: 0 });

  async function propose(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const cid = String(formData.get("companyId") || "");
    const lines: AdjLineInput[] = [];
    for (let i = 0; i < LINE_ROWS; i++) {
      const acc = String(formData.get(`acc_${i}`) || "").trim();
      const dr = Number(formData.get(`dr_${i}`) || 0);
      const cr = Number(formData.get(`cr_${i}`) || 0);
      if (acc && (dr > 0 || cr > 0)) lines.push({ accountCode: acc, accountName: String(formData.get(`nm_${i}`) || "") || null, debit: dr, credit: cr });
    }
    const r = proposeAdjustment({
      companyId: cid, description: String(formData.get("description") || ""),
      findingId: String(formData.get("findingId") || "") || null, lines, userId: admin.sub,
    });
    if (isP5Error(r)) redirect(`/adjustments?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/adjustments?companyId=${cid}&ok=${encodeURIComponent("تم اقتراح التسوية (متوازنة)")}`);
  }
  async function decide(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const cid = String(formData.get("companyId") || "");
    const r = decideAdjustment({ adjustmentId: String(formData.get("adjustmentId") || ""), decision: (String(formData.get("decision")) as any), userId: admin.sub });
    if (isP5Error(r)) redirect(`/adjustments?companyId=${cid}&error=${encodeURIComponent(r.error)}`);
    redirect(`/adjustments?companyId=${cid}&ok=${encodeURIComponent("تم تحديث حالة التسوية")}`);
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">التسويات</h1>
      <p className="text-gray-500 text-sm mb-6">قيود تسوية مقترحة يجب أن تتوازن (مدين = دائن)؛ التسويات المعتمدة تنعكس على الميزان المعدّل.</p>

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
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">مقترحة</div><div className="text-3xl font-bold mt-1 text-amber-600">{counts.PROPOSED}</div></div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">معتمدة</div><div className="text-3xl font-bold mt-1 text-emerald-600">{counts.APPROVED}</div></div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">مرفوضة</div><div className="text-3xl font-bold mt-1">{counts.REJECTED}</div></div>
      </div>

      {/* Adjustments list */}
      <div className="space-y-3 mb-8">
        {adjustments.length === 0 && <div className="bg-white rounded-xl border border-gray-100 p-6 text-center text-gray-400 text-sm">لا تسويات بعد.</div>}
        {adjustments.map((a) => {
          const balanced = Math.abs(a.total_debit - a.total_credit) <= 0.005;
          return (
            <div key={a.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-3 mb-2">
                <span className={`inline-block rounded-full text-xs px-2 py-1 ${AST[a.status]?.cls}`}>{AST[a.status]?.label}</span>
                <span className="font-semibold">{a.description}</span>
                <span className={`text-xs ${balanced ? "text-emerald-600" : "text-red-600"}`}>{balanced ? "متوازنة" : "غير متوازنة"}</span>
              </div>
              <table className="w-full text-xs mb-2">
                <thead className="text-gray-400"><tr><th className="text-right py-1">الحساب</th><th className="text-right py-1">مدين</th><th className="text-right py-1">دائن</th></tr></thead>
                <tbody>
                  {a.lines.map((l) => (
                    <tr key={l.id} className="border-t"><td className="py-1">{l.account_code} {l.account_name ? `— ${l.account_name}` : ""}</td><td className="py-1">{fmt(l.debit)}</td><td className="py-1">{fmt(l.credit)}</td></tr>
                  ))}
                  <tr className="border-t font-semibold"><td className="py-1">الإجمالي</td><td className="py-1">{fmt(a.total_debit)}</td><td className="py-1">{fmt(a.total_credit)}</td></tr>
                </tbody>
              </table>
              {isAdmin && a.status === "PROPOSED" && (
                <div className="flex gap-2 pt-2 border-t">
                  <form action={decide}><input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="adjustmentId" value={a.id} /><input type="hidden" name="decision" value="APPROVED" /><button className="bg-emerald-600 text-white rounded-lg px-3 py-1.5 text-xs hover:opacity-90">اعتماد</button></form>
                  <form action={decide}><input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="adjustmentId" value={a.id} /><input type="hidden" name="decision" value="REJECTED" /><button className="bg-gray-200 text-gray-700 rounded-lg px-3 py-1.5 text-xs hover:bg-gray-300">رفض</button></form>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Adjusted trial balance */}
      {adjTB.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
          <div className="px-6 py-4 border-b"><h2 className="font-semibold">الميزان المعدّل (المستورد + التسويات المعتمدة)</h2></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr><th className="text-right px-4 py-3">الحساب</th><th className="text-right px-4 py-3">صافي الميزان</th><th className="text-right px-4 py-3">تسوية مدين</th><th className="text-right px-4 py-3">تسوية دائن</th><th className="text-right px-4 py-3">الصافي المعدّل</th></tr>
              </thead>
              <tbody className="divide-y">
                {adjTB.map((r) => {
                  const changed = r.adj_debit !== 0 || r.adj_credit !== 0;
                  return (
                    <tr key={r.account_code} className={changed ? "bg-amber-50/40" : ""}>
                      <td className="px-4 py-2">{r.account_code} {r.account_name ? `— ${r.account_name}` : ""}</td>
                      <td className="px-4 py-2 text-gray-600">{fmt(r.tb_debit - r.tb_credit)}</td>
                      <td className="px-4 py-2">{r.adj_debit ? fmt(r.adj_debit) : "—"}</td>
                      <td className="px-4 py-2">{r.adj_credit ? fmt(r.adj_credit) : "—"}</td>
                      <td className="px-4 py-2 font-medium">{fmt(r.adjusted_net)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50 font-semibold"><tr><td className="px-4 py-3">الإجمالي (يجب أن يبقى صفرًا)</td><td className="px-4 py-3">{fmt(tbTotals.net)}</td><td colSpan={2}></td><td className="px-4 py-3">{fmt(tbTotals.adjNet)}</td></tr></tfoot>
            </table>
          </div>
          {!hasAdjustments && <p className="px-6 py-3 text-xs text-gray-400">لا تسويات معتمدة بعد — الصافي المعدّل = الميزان المستورد.</p>}
        </div>
      )}

      {/* Propose form (ADMIN or EXECUTOR) */}
      {canWrite && companyId && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold mb-1">اقتراح تسوية</h2>
          <p className="text-xs text-gray-400 mb-4">أدخل سطرين على الأقل. يجب أن يتساوى إجمالي المدين مع الدائن وإلا تُرفض.</p>
          <form action={propose} className="space-y-3">
            <input type="hidden" name="companyId" value={companyId} />
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-xs font-medium text-gray-600 mb-1">الوصف</label><input name="description" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" /></div>
              <div><label className="block text-xs font-medium text-gray-600 mb-1">مرتبطة بملاحظة (اختياري)</label>
                <select name="findingId" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">—</option>{findings.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}</select>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead className="text-gray-400 text-xs"><tr><th className="text-right py-1">رمز الحساب</th><th className="text-right py-1">اسم الحساب</th><th className="text-right py-1">مدين</th><th className="text-right py-1">دائن</th></tr></thead>
              <tbody>
                {Array.from({ length: LINE_ROWS }).map((_, i) => (
                  <tr key={i}>
                    <td className="py-1 pe-2"><input name={`acc_${i}`} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></td>
                    <td className="py-1 pe-2"><input name={`nm_${i}`} className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></td>
                    <td className="py-1 pe-2"><input name={`dr_${i}`} type="number" step="0.01" min="0" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></td>
                    <td className="py-1"><input name={`cr_${i}`} type="number" step="0.01" min="0" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">اقتراح التسوية</button>
          </form>
        </div>
      )}
    </div>
  );
}
