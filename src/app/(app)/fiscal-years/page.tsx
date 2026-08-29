import { redirect } from "next/navigation";
import { requireSession, requireAdmin } from "@/lib/auth";
import {
  createFiscalYear,
  listCompanies,
  listFiscalYears,
  updateFiscalYearStatus,
  writeAuditLog,
  type FiscalYearStatus,
} from "@/lib/repo";

const STATUS_LABEL: Record<FiscalYearStatus, string> = {
  DRAFT: "مسودة",
  IN_PROGRESS: "قيد التنفيذ",
  CLOSED: "مقفلة",
};

export default async function FiscalYearsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const session = await requireSession();
  const companies = listCompanies();
  const fiscalYears = listFiscalYears();
  const companyMap = new Map(companies.map((c) => [c.id, c.legal_name]));

  async function create(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const companyId = String(formData.get("companyId") || "");
    const year = Number(formData.get("year"));
    const startDate = String(formData.get("startDate") || "");
    const endDate = String(formData.get("endDate") || "");
    if (!companyId || !year || !startDate || !endDate) redirect("/fiscal-years?error=1");

    try {
      const fy = createFiscalYear({ companyId, year, startDate, endDate });
      writeAuditLog({ userId: admin.sub, action: "CREATE", entityType: "FiscalYear", entityId: fy.id, details: { year, companyId } });
    } catch (err: any) {
      if (err?.code === "ERR_SQLITE_ERROR" && err?.errcode === 2067) {
        redirect("/fiscal-years?error=duplicate");
      }
      throw err;
    }
    redirect("/fiscal-years");
  }

  async function setStatus(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const fyId = String(formData.get("fyId") || "");
    const status = String(formData.get("status") || "DRAFT") as FiscalYearStatus;
    updateFiscalYearStatus(fyId, status);
    writeAuditLog({ userId: admin.sub, action: "UPDATE", entityType: "FiscalYear", entityId: fyId, details: { status } });
    redirect("/fiscal-years");
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">السنوات المالية</h1>

      {searchParams.error === "duplicate" && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          توجد سنة مالية بنفس الرقم لهذه الشركة بالفعل.
        </div>
      )}
      {searchParams.error === "1" && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          الرجاء تعبئة جميع الحقول المطلوبة.
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-right px-4 py-3">الشركة</th>
              <th className="text-right px-4 py-3">السنة</th>
              <th className="text-right px-4 py-3">البداية</th>
              <th className="text-right px-4 py-3">النهاية</th>
              <th className="text-right px-4 py-3">الحالة</th>
              {session.role === "ADMIN" && <th className="px-4 py-3"></th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {fiscalYears.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-gray-400 text-center">
                  لا توجد سنوات مالية بعد.
                </td>
              </tr>
            )}
            {fiscalYears.map((fy) => (
              <tr key={fy.id}>
                <td className="px-4 py-3">{companyMap.get(fy.company_id) ?? "—"}</td>
                <td className="px-4 py-3 font-medium">{fy.year}</td>
                <td className="px-4 py-3 text-gray-500">{fy.start_date}</td>
                <td className="px-4 py-3 text-gray-500">{fy.end_date}</td>
                <td className="px-4 py-3">
                  <span className="inline-block rounded-full bg-navyLight text-navy text-xs px-2 py-1">
                    {STATUS_LABEL[fy.status]}
                  </span>
                </td>
                {session.role === "ADMIN" && (
                  <td className="px-4 py-3">
                    <form action={setStatus} className="flex items-center gap-2">
                      <input type="hidden" name="fyId" value={fy.id} />
                      <select name="status" defaultValue={fy.status} className="text-xs border rounded px-2 py-1">
                        {Object.entries(STATUS_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <button className="text-xs text-navy hover:underline">تحديث</button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {session.role === "ADMIN" ? (
        companies.length === 0 ? (
          <p className="text-sm text-gray-400">أضِف شركة أولًا من صفحة "الشركة" قبل إنشاء سنة مالية.</p>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h2 className="font-semibold mb-4">إضافة سنة مالية</h2>
            <form action={create} className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">الشركة</label>
                <select name="companyId" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.legal_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">السنة</label>
                <input
                  name="year"
                  type="number"
                  required
                  defaultValue={new Date().getFullYear()}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">تاريخ البداية</label>
                <input name="startDate" type="date" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">تاريخ النهاية</label>
                <input name="endDate" type="date" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              <div className="col-span-2">
                <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
                  حفظ
                </button>
              </div>
            </form>
          </div>
        )
      ) : (
        <p className="text-sm text-gray-400">دورك (مراجع) للاطلاع فقط.</p>
      )}
    </div>
  );
}
