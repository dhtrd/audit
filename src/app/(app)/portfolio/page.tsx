import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { computePortfolio } from "@/lib/portfolio";

const RLEVEL: Record<string, { label: string; cls: string }> = {
  HIGH: { label: "جاهز", cls: "bg-emerald-100 text-emerald-700" },
  MEDIUM: { label: "شبه جاهز", cls: "bg-amber-100 text-amber-700" },
  LOW: { label: "غير جاهز", cls: "bg-red-100 text-red-700" },
};
const RISK: Record<string, { label: string; cls: string }> = {
  HIGH: { label: "مرتفع", cls: "bg-red-100 text-red-700" },
  MEDIUM: { label: "متوسط", cls: "bg-amber-100 text-amber-700" },
  LOW: { label: "منخفض", cls: "bg-emerald-100 text-emerald-700" },
  INFO: { label: "—", cls: "bg-gray-100 text-gray-500" },
};

export default async function PortfolioPage() {
  await requireSession();
  const { rows, totals } = computePortfolio();

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-bold mb-1">لوحة المحفظة</h1>
      <p className="text-gray-500 text-sm mb-6">نظرة شاملة على جاهزية ومخاطر كل الشركات، مرتبة بالأولوية (الأقل جاهزية أولًا).</p>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          لا توجد شركات بعد. <Link href="/company" className="text-navy underline">أضِف شركة</Link>.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-4 mb-6">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">الشركات</div><div className="text-3xl font-bold mt-1">{totals.companies}</div><div className="text-xs text-gray-500 mt-0.5">{totals.withData} ببيانات</div></div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">متوسط الجاهزية</div><div className="text-3xl font-bold mt-1">{totals.avgReadiness}%</div></div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">جاهزة</div><div className="text-3xl font-bold mt-1 text-emerald-600">{totals.ready}</div></div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">ملاحظات مفتوحة</div><div className="text-3xl font-bold mt-1 text-amber-600">{totals.totalOpenFindings}</div></div>
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4"><div className="text-xs text-gray-400">مخاطر مرتفعة</div><div className="text-3xl font-bold mt-1 text-red-600">{totals.totalHighRiskFlags}</div></div>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="text-right px-4 py-3">الشركة</th>
                    <th className="text-right px-4 py-3">الجاهزية</th>
                    <th className="text-right px-4 py-3">المخاطر</th>
                    <th className="text-right px-4 py-3">ملاحظات مفتوحة</th>
                    <th className="text-right px-4 py-3">الإجراءات</th>
                    <th className="text-right px-4 py-3">التغطية</th>
                    <th className="text-right px-4 py-3">مراجعة الإدارة</th>
                    <th className="text-right px-4 py-3">آخر استيراد</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.companyId} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-medium">{r.name}</td>
                      <td className="px-4 py-2.5">
                        {r.hasData ? (
                          <span className="flex items-center gap-2">
                            <b>{r.readinessScore}</b>
                            <span className={`inline-block rounded-full text-xs px-2 py-0.5 ${RLEVEL[r.readinessLevel].cls}`}>{RLEVEL[r.readinessLevel].label}</span>
                          </span>
                        ) : <span className="text-xs text-gray-400">لا بيانات</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.hasData ? <span className="flex items-center gap-2"><b>{r.riskScore}</b><span className={`inline-block rounded-full text-xs px-2 py-0.5 ${RISK[r.riskLevel].cls}`}>{RISK[r.riskLevel].label}</span></span> : "—"}
                      </td>
                      <td className="px-4 py-2.5">{r.openFindings > 0 ? <span className="text-amber-700 font-medium">{r.openFindings}</span> : <span className="text-gray-400">0</span>} / {r.totalFindings}</td>
                      <td className="px-4 py-2.5 text-gray-600">{r.proceduresDone} منجز · {r.proceduresOpen} مفتوح</td>
                      <td className="px-4 py-2.5">{r.coveragePct}%</td>
                      <td className="px-4 py-2.5">{r.lastReview ? (r.lastReview === "APPROVED" ? <span className="text-emerald-600 text-xs">معتمد</span> : <span className="text-amber-600 text-xs">مُعاد</span>) : <span className="text-gray-400 text-xs">—</span>}</td>
                      <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{r.lastImportAt ?? "—"}</td>
                      <td className="px-4 py-2.5"><Link href={`/dashboard?companyId=${r.companyId}`} className="text-xs text-navy hover:underline whitespace-nowrap">فتح ←</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
