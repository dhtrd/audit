import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, requireExecutor, canExecute } from "@/lib/auth";
import { listCompanies, listFiscalYears, listImportBatches } from "@/lib/repo";
import { uploadAndDetect, autoImportOne, isImportError } from "@/lib/import-actions";
import { repairFileName } from "@/lib/upload";

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  UPLOADED: { label: "مرفوع", cls: "bg-gray-100 text-gray-600" },
  MAPPED: { label: "بانتظار الاستيراد", cls: "bg-amber-100 text-amber-700" },
  VALIDATED: { label: "تم التحقق", cls: "bg-blue-100 text-blue-700" },
  COMMITTED: { label: "مستورد ✓", cls: "bg-emerald-100 text-emerald-700" },
  BLOCKED: { label: "محظور ✕", cls: "bg-red-100 text-red-700" },
};
const TYPE_LABEL: Record<string, string> = {
  TRIAL_BALANCE: "ميزان مراجعة",
  GENERAL_LEDGER: "أستاذ عام",
  UNKNOWN: "غير محدد",
};

export default async function ImportsPage({ searchParams }: {
  searchParams: { error?: string; committed?: string; blocked?: string; manual?: string; errors?: string; rows?: string };
}) {
  const session = await requireSession();
  const companies = listCompanies();
  const fiscalYears = listFiscalYears();
  const batches = listImportBatches();

  async function upload(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const file = formData.get("file");
    const companyId = String(formData.get("companyId") || "");
    const fiscalYearId = formData.get("fiscalYearId") ? String(formData.get("fiscalYearId")) : null;
    if (!(file instanceof File) || file.size === 0) redirect("/imports?error=nofile");
    const f = file as File;
    const buffer = Buffer.from(await f.arrayBuffer());
    const result = await uploadAndDetect({ companyId, fiscalYearId, fileName: f.name, buffer, userId: admin.sub });
    if (isImportError(result)) redirect(`/imports?error=${encodeURIComponent(result.error)}`);
    redirect(`/imports/${(result as any).id}`);
  }

  // Multi-file: auto-detect + auto-map + commit each file into the same
  // company in one action. Unbalanced files are BLOCKED (never kept); files
  // that can't be auto-mapped are left for manual mapping.
  async function uploadMany(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const companyId = String(formData.get("companyId") || "");
    const fiscalYearId = formData.get("fiscalYearId") ? String(formData.get("fiscalYearId")) : null;
    const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) redirect("/imports?error=nofile");
    let committed = 0, blocked = 0, manual = 0, errors = 0, rows = 0;
    for (const f of files) {
      const buffer = Buffer.from(await f.arrayBuffer());
      const r = await autoImportOne({ companyId, fiscalYearId, fileName: f.name, buffer, userId: admin.sub });
      if (r.status === "COMMITTED") { committed++; rows += r.rows ?? 0; }
      else if (r.status === "BLOCKED") blocked++;
      else if (r.status === "NEEDS_MAPPING") manual++;
      else errors++;
    }
    redirect(`/imports?committed=${committed}&blocked=${blocked}&manual=${manual}&errors=${errors}&rows=${rows}`);
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold mb-1">استيراد البيانات</h1>
      <p className="text-gray-500 text-sm mb-6">
        رفع ميزان المراجعة والأستاذ العام من Excel/CSV، مع اكتشاف النوع وربط الأعمدة والتحقق والتسوية الإلزامية.
      </p>

      {searchParams.error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {searchParams.error === "nofile" ? "الرجاء اختيار ملف." : searchParams.error}
        </div>
      )}

      {searchParams.committed !== undefined && (
        <div className="mb-4 text-sm bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
          <b className="text-emerald-800">اكتمل الاستيراد المتعدد:</b>{" "}
          <span className="text-emerald-700">{searchParams.committed} ملف مستورد ✓ ({Number(searchParams.rows ?? 0).toLocaleString("en-US")} قيد)</span>
          {Number(searchParams.blocked ?? 0) > 0 && <span className="text-red-700"> · {searchParams.blocked} محظور (فرق تسوية) ✕</span>}
          {Number(searchParams.manual ?? 0) > 0 && <span className="text-amber-700"> · {searchParams.manual} يحتاج ربطًا يدويًا</span>}
          {Number(searchParams.errors ?? 0) > 0 && <span className="text-red-700"> · {searchParams.errors} فشل قراءته</span>}
          <span className="text-gray-500 block mt-1 text-xs">التفاصيل في الجدول أدناه — افتح أي ملف محظور/بانتظار الربط لمعالجته.</span>
        </div>
      )}

      {canExecute(session.role) ? (
        companies.length === 0 ? (
          <p className="text-sm text-gray-400 mb-8">أضِف شركة أولًا من صفحة &quot;الشركة&quot; قبل الاستيراد.</p>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-8">
            <h2 className="font-semibold mb-4">رفع ملف جديد</h2>
            <form action={upload} className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">الشركة</label>
                <select name="companyId" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.legal_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">السنة المالية (اختياري)</label>
                <select name="fiscalYearId" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">—</option>
                  {fiscalYears.map((fy) => (
                    <option key={fy.id} value={fy.id}>{fy.year}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">الملف (xlsx / xls / csv)</label>
                <input
                  name="file"
                  type="file"
                  required
                  accept=".xlsx,.xlsm,.xls,.csv"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm file:me-3 file:rounded-md file:border-0 file:bg-navy file:text-white file:px-3 file:py-1"
                />
              </div>
              <div className="col-span-2">
                <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
                  رفع واكتشاف النوع
                </button>
              </div>
            </form>

            {/* Multi-file auto-import */}
            <div className="mt-8 pt-6 border-t border-gray-100">
              <h2 className="font-semibold mb-1">رفع عدة ملفات دفعة واحدة (استيراد تلقائي)</h2>
              <p className="text-xs text-gray-500 mb-4">
                اختر عدة ملفات أستاذ عام/ميزان (مثلاً كل الأشهر) — يكتشف النظام النوع ويربط الأعمدة ويستوردها تلقائيًا، مع التسوية الإلزامية لكل ملف. أي ملف غير متوازن يُحظر ولا تُعتمد بياناته.
              </p>
              <form action={uploadMany} className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">الشركة</label>
                  <select name="companyId" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>{c.legal_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">السنة المالية (اختياري)</label>
                  <select name="fiscalYearId" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    <option value="">—</option>
                    {fiscalYears.map((fy) => (
                      <option key={fy.id} value={fy.id}>{fy.year}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-1">الملفات (اختر عدة ملفات معًا)</label>
                  <input
                    name="files"
                    type="file"
                    multiple
                    required
                    accept=".xlsx,.xlsm,.xls,.csv"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm file:me-3 file:rounded-md file:border-0 file:bg-navy file:text-white file:px-3 file:py-1"
                  />
                </div>
                <div className="col-span-2">
                  <button className="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
                    رفع واستيراد الكل تلقائيًا
                  </button>
                  <span className="text-xs text-gray-400 me-3">قد يستغرق دقائق مع الملفات الكبيرة — لا تُغلق النافذة.</span>
                </div>
              </form>
            </div>
          </div>
        )
      ) : (
        <p className="text-sm text-gray-400 mb-8">دورك (مراجع) للاطلاع فقط — لا يمكنك رفع ملفات.</p>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-right px-4 py-3">الملف</th>
              <th className="text-right px-4 py-3">النوع</th>
              <th className="text-right px-4 py-3">الحالة</th>
              <th className="text-right px-4 py-3">الجودة</th>
              <th className="text-right px-4 py-3">الصفوف</th>
              <th className="text-right px-4 py-3">بواسطة</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {batches.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-gray-400 text-center">لا توجد عمليات استيراد بعد.</td></tr>
            )}
            {batches.map((b) => {
              const badge = STATUS_BADGE[b.status] ?? { label: b.status, cls: "bg-gray-100 text-gray-600" };
              const type = b.confirmed_type ?? b.detected_type ?? "UNKNOWN";
              return (
                <tr key={b.id}>
                  <td className="px-4 py-3 font-medium">{repairFileName(b.file_name)}</td>
                  <td className="px-4 py-3 text-gray-600">{TYPE_LABEL[type] ?? type}</td>
                  <td className="px-4 py-3"><span className={`inline-block rounded-full text-xs px-2 py-1 ${badge.cls}`}>{badge.label}</span></td>
                  <td className="px-4 py-3 text-gray-600">{b.quality_score != null ? `${b.quality_score}%` : "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{b.total_rows ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-500">{(b as any).creator_name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Link href={`/imports/${b.id}`} className="text-navy hover:underline text-xs">فتح</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
