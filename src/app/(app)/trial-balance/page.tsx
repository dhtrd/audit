import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { listCompanies, listTrialBalances } from "@/lib/repo";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function TrialBalancePage({ searchParams }: { searchParams: { companyId?: string } }) {
  await requireSession();
  const companies = listCompanies();
  const companyId = searchParams.companyId || companies[0]?.id || "";
  const rows = companyId ? listTrialBalances(companyId) : [];

  const totals = rows.reduce((t, r) => ({
    opening: t.opening + r.opening_balance,
    debit: t.debit + r.debit,
    credit: t.credit + r.credit,
    closing: t.closing + r.closing_balance,
  }), { opening: 0, debit: 0, credit: 0, closing: 0 });
  const balanced = Math.abs(totals.debit - totals.credit) <= 0.005;

  return (
    <div className="max-w-6xl">
      <h1 className="text-2xl font-bold mb-1">ميزان المراجعة</h1>
      <p className="text-gray-500 text-sm mb-6">
        البيانات المستوردة فعليًا من قاعدة البيانات. اضغط على أي حساب لعرض قيوده في الأستاذ العام (Drill-down).
      </p>

      {companies.length > 1 && (
        <form className="mb-5">
          <label className="block text-xs font-medium text-gray-600 mb-1">الشركة</label>
          <select name="companyId" defaultValue={companyId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.legal_name}</option>)}
          </select>
          <button className="ms-2 bg-gray-100 border rounded-lg px-3 py-2 text-sm hover:bg-gray-200">عرض</button>
        </form>
      )}

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          لا توجد بيانات ميزان مراجعة مستوردة لهذه الشركة بعد.{" "}
          <Link href="/imports" className="text-navy underline">ابدأ استيرادًا</Link>
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <span className={`inline-block rounded-full text-xs px-3 py-1 ${balanced ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
              {balanced ? "متوازن: مدين = دائن" : `غير متوازن — فرق ${fmt(Math.abs(totals.debit - totals.credit))}`}
            </span>
            <span className="text-sm text-gray-500">{rows.length} حساب</span>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="text-right px-4 py-3">رمز الحساب</th>
                    <th className="text-right px-4 py-3">اسم الحساب</th>
                    <th className="text-right px-4 py-3">افتتاحي</th>
                    <th className="text-right px-4 py-3">مدين</th>
                    <th className="text-right px-4 py-3">دائن</th>
                    <th className="text-right px-4 py-3">ختامي</th>
                    <th className="text-right px-4 py-3">المصدر</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-medium">
                        <Link href={`/trial-balance/${encodeURIComponent(r.account_code)}?companyId=${companyId}`} className="text-navy hover:underline">
                          {r.account_code}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">{r.account_name ?? "—"}</td>
                      <td className="px-4 py-2.5 text-gray-500">{fmt(r.opening_balance)}</td>
                      <td className="px-4 py-2.5">{fmt(r.debit)}</td>
                      <td className="px-4 py-2.5">{fmt(r.credit)}</td>
                      <td className="px-4 py-2.5 text-gray-500">{fmt(r.closing_balance)}</td>
                      <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{r.source_file}
                        {r.source_sheet ? ` / ${r.source_sheet}` : ""} : صف {r.source_row}</td>
                      <td className="px-4 py-2.5">
                        {r.entry_count > 0 ? (
                          <Link href={`/trial-balance/${encodeURIComponent(r.account_code)}?companyId=${companyId}`} className="text-xs text-navy hover:underline whitespace-nowrap">
                            {r.entry_count} قيد ←
                          </Link>
                        ) : <span className="text-xs text-gray-300">لا قيود</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-semibold">
                  <tr>
                    <td className="px-4 py-3" colSpan={2}>الإجمالي</td>
                    <td className="px-4 py-3">{fmt(totals.opening)}</td>
                    <td className="px-4 py-3">{fmt(totals.debit)}</td>
                    <td className="px-4 py-3">{fmt(totals.credit)}</td>
                    <td className="px-4 py-3">{fmt(totals.closing)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
