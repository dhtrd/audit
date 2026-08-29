import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getCompany, getTrialBalanceAccount, listGeneralLedgerByAccount } from "@/lib/repo";

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Real drill-down: from a trial-balance account to its General Ledger
// entries, resolved by an SQL query (company_id + account_code) — not by
// any pre-shaped data held in the UI.
export default async function AccountLedgerPage({
  params, searchParams,
}: { params: { account: string }; searchParams: { companyId?: string } }) {
  await requireSession();
  const accountCode = decodeURIComponent(params.account);
  const companyId = searchParams.companyId || "";
  const company = companyId ? getCompany(companyId) : undefined;
  const tbRow = companyId ? getTrialBalanceAccount(companyId, accountCode) : undefined;
  const entries = companyId ? listGeneralLedgerByAccount(companyId, accountCode) : [];

  const totals = entries.reduce((t, e) => ({ debit: t.debit + e.debit, credit: t.credit + e.credit }), { debit: 0, credit: 0 });

  return (
    <div className="max-w-6xl">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-2">
        <Link href={`/trial-balance?companyId=${companyId}`} className="hover:underline">ميزان المراجعة</Link>
        <span>/</span>
        <span className="text-gray-600">الحساب {accountCode}</span>
      </div>
      <h1 className="text-2xl font-bold mb-1">
        الأستاذ العام — {accountCode}
        {tbRow?.account_name ? <span className="text-gray-500 font-normal"> ({tbRow.account_name})</span> : null}
      </h1>
      <p className="text-gray-500 text-sm mb-6">{company?.legal_name ?? ""}</p>

      {tbRow && (
        <div className="mb-5 grid grid-cols-4 gap-3 max-w-2xl">
          <div className="bg-white rounded-lg border border-gray-100 p-3">
            <div className="text-xs text-gray-400">مدين (ميزان)</div><div className="font-semibold">{fmt(tbRow.debit)}</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-100 p-3">
            <div className="text-xs text-gray-400">دائن (ميزان)</div><div className="font-semibold">{fmt(tbRow.credit)}</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-100 p-3">
            <div className="text-xs text-gray-400">مدين (قيود GL)</div><div className="font-semibold">{fmt(totals.debit)}</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-100 p-3">
            <div className="text-xs text-gray-400">دائن (قيود GL)</div><div className="font-semibold">{fmt(totals.credit)}</div>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
          لا توجد قيود أستاذ عام مستوردة لهذا الحساب. (استورد ملف أستاذ عام يحتوي هذا الحساب لرؤية قيوده هنا.)
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="text-right px-4 py-3">التاريخ</th>
                  <th className="text-right px-4 py-3">اليومية</th>
                  <th className="text-right px-4 py-3">المرجع</th>
                  <th className="text-right px-4 py-3">الطرف</th>
                  <th className="text-right px-4 py-3">البيان</th>
                  <th className="text-right px-4 py-3">مدين</th>
                  <th className="text-right px-4 py-3">دائن</th>
                  <th className="text-right px-4 py-3">المصدر</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 whitespace-nowrap">{e.entry_date ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600">{e.journal ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600">{e.reference ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-600">{e.partner ?? "—"}</td>
                    <td className="px-4 py-2.5 text-gray-700">{e.description ?? "—"}</td>
                    <td className="px-4 py-2.5">{fmt(e.debit)}</td>
                    <td className="px-4 py-2.5">{fmt(e.credit)}</td>
                    <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{e.source_file}: صف {e.source_row}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 font-semibold">
                <tr>
                  <td className="px-4 py-3" colSpan={5}>الإجمالي ({entries.length} قيد)</td>
                  <td className="px-4 py-3">{fmt(totals.debit)}</td>
                  <td className="px-4 py-3">{fmt(totals.credit)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
