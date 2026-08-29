import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { requireSession, requireExecutor, canExecute } from "@/lib/auth";
import { getProcedure, listEvidence, listUsers, type ProcedureStatus } from "@/lib/repo";
import { updateProcedureAction, addEvidenceFile, isProcError } from "@/lib/procedure-actions";
import { riskTypeLabel } from "@/lib/risk";

const SEV: Record<string, { label: string; cls: string }> = {
  HIGH: { label: "مرتفع", cls: "bg-red-100 text-red-700" }, MEDIUM: { label: "متوسط", cls: "bg-amber-100 text-amber-700" },
  LOW: { label: "منخفض", cls: "bg-blue-100 text-blue-700" }, INFO: { label: "معلومة", cls: "bg-gray-100 text-gray-600" },
  MANUAL: { label: "يدوي", cls: "bg-purple-100 text-purple-700" },
};
const STATUS_LABEL: Record<ProcedureStatus, string> = { OPEN: "مفتوح", IN_PROGRESS: "قيد التنفيذ", DONE: "منجز", NA: "لا ينطبق" };
const fmtSize = (n: number | null) => n == null ? "" : n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1048576).toFixed(1)}MB`;

export default async function ProcedureDetailPage({
  params, searchParams,
}: { params: { id: string }; searchParams: { error?: string; ok?: string } }) {
  const session = await requireSession();
  const isAdmin = canExecute(session.role);
  const proc = getProcedure(params.id);
  if (!proc) notFound();
  const evidence = listEvidence(proc.id);
  const users = isAdmin ? listUsers() : [];

  async function save(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const status = String(formData.get("status") || "") as ProcedureStatus;
    const conclusion = String(formData.get("conclusion") || "") || null;
    const assignedTo = String(formData.get("assignedTo") || "") || null;
    const r = updateProcedureAction({ procedureId: params.id, status, conclusion, assignedTo, userId: admin.sub });
    if (isProcError(r)) redirect(`/procedures/${params.id}?error=${encodeURIComponent(r.error)}`);
    redirect(`/procedures/${params.id}?ok=${encodeURIComponent("تم الحفظ")}`);
  }
  async function upload(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const file = formData.get("file");
    const note = String(formData.get("note") || "") || null;
    if (!(file instanceof File) || file.size === 0) redirect(`/procedures/${params.id}?error=${encodeURIComponent("اختر ملف الدليل")}`);
    const f = file as File;
    const buffer = Buffer.from(await f.arrayBuffer());
    const r = addEvidenceFile({ procedureId: params.id, fileName: f.name, buffer, note, userId: admin.sub });
    if (isProcError(r)) redirect(`/procedures/${params.id}?error=${encodeURIComponent(r.error)}`);
    redirect(`/procedures/${params.id}?ok=${encodeURIComponent("تم رفع الدليل")}`);
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-2">
        <Link href="/procedures" className="hover:underline">الأدلة والإجراءات</Link><span>/</span>
        <span className="text-gray-600">إجراء</span>
      </div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-2xl font-bold">{proc.title}</h1>
        <span className={`inline-block rounded-full text-xs px-2 py-1 ${SEV[proc.severity]?.cls}`}>{SEV[proc.severity]?.label}</span>
      </div>

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        {proc.description && <p className="text-sm text-gray-700 mb-3">{proc.description}</p>}
        <div className="flex flex-wrap gap-4 text-sm text-gray-500">
          <div>الحالة الحالية: <b className="text-gray-700">{STATUS_LABEL[proc.status]}</b></div>
          {proc.risk_type && <div>مصدر المخاطرة: <b className="text-gray-700">{riskTypeLabel(proc.risk_type)}</b></div>}
          {proc.account_code && (
            <div>الحساب: <Link href={`/trial-balance/${encodeURIComponent(proc.account_code)}?companyId=${proc.company_id}`} className="text-navy hover:underline">{proc.account_code} — عرض القيود ←</Link></div>
          )}
        </div>
      </div>

      {/* Status / conclusion */}
      {isAdmin ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h2 className="font-semibold mb-4">تنفيذ الإجراء</h2>
          <form action={save} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">الحالة</label>
                <select name="status" defaultValue={proc.status} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">المسؤول</label>
                <select name="assignedTo" defaultValue={proc.assigned_to ?? ""} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="">—</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">الاستنتاج (مطلوب لإنهاء الإجراء)</label>
              <textarea name="conclusion" rows={3} defaultValue={proc.conclusion ?? ""} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">حفظ</button>
          </form>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6 text-sm text-gray-600">
          <div>الحالة: {STATUS_LABEL[proc.status]}</div>
          {proc.conclusion && <div className="mt-2">الاستنتاج: {proc.conclusion}</div>}
        </div>
      )}

      {/* Evidence */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
        <div className="px-6 py-4 border-b"><h2 className="font-semibold">الأدلة ({evidence.length})</h2></div>
        {evidence.length === 0 ? (
          <p className="px-6 py-6 text-gray-400 text-sm">لا توجد أدلة مرفقة بعد.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-right px-4 py-3">الملف</th>
                <th className="text-right px-4 py-3">الحجم</th>
                <th className="text-right px-4 py-3">ملاحظة</th>
                <th className="text-right px-4 py-3">بواسطة</th>
                <th className="text-right px-4 py-3">التاريخ</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {evidence.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2.5 font-medium">
                    <a href={`/api/procedures/${proc.id}/evidence/${e.id}`} className="text-navy hover:underline">{e.file_name}</a>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">{fmtSize(e.file_size)}</td>
                  <td className="px-4 py-2.5 text-gray-600">{e.note ?? "—"}</td>
                  <td className="px-4 py-2.5 text-gray-500">{(e as any).uploader_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs whitespace-nowrap">{e.uploaded_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {isAdmin && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold mb-4">رفع دليل</h2>
          <form action={upload} className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">الملف</label>
              <input name="file" type="file" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm file:me-3 file:rounded-md file:border-0 file:bg-navy file:text-white file:px-3 file:py-1" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">ملاحظة (اختياري)</label>
              <input name="note" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div className="col-span-2">
              <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">رفع الدليل</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
