import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { requireSession, requireExecutor, canExecute } from "@/lib/auth";
import {
  getImportBatch, listMappingTemplates, createMappingTemplate,
  type ImportFileType,
} from "@/lib/repo";
import { fieldsForType, requiredFieldsForType } from "@/lib/import-fields";
import { parseFile } from "@/lib/excel";
import { setConfirmedType, saveMapping, runCommit, isImportError } from "@/lib/import-actions";
import type { QualityCheck } from "@/lib/import-service";

const TYPE_LABEL: Record<string, string> = { TRIAL_BALANCE: "ميزان مراجعة", GENERAL_LEDGER: "أستاذ عام", UNKNOWN: "غير محدد" };
const fmtMoney = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function ImportWizardPage({
  params, searchParams,
}: { params: { id: string }; searchParams: { error?: string; ok?: string } }) {
  const session = await requireSession();
  const batch = getImportBatch(params.id);
  if (!batch) notFound();

  const isAdmin = canExecute(session.role);
  const currentType: ImportFileType | null =
    batch.confirmed_type ?? (batch.detected_type === "TRIAL_BALANCE" || batch.detected_type === "GENERAL_LEDGER" ? batch.detected_type : null);
  const mapping: Record<string, string> = batch.mapping_json ? JSON.parse(batch.mapping_json) : {};
  const templates = currentType ? listMappingTemplates(currentType) : [];

  // Parse a small preview so the user sees their data while mapping.
  let preview: { headers: string[]; rows: Record<string, unknown>[] } | null = null;
  try {
    const parsed = await parseFile(batch.stored_path, batch.file_name);
    preview = { headers: parsed.headers, rows: parsed.rows.slice(0, 8).map((r) => r.cells) };
  } catch { preview = null; }

  const headers: string[] = batch.headers_json ? JSON.parse(batch.headers_json) : (preview?.headers ?? []);
  const qualityChecks: QualityCheck[] = batch.quality_json ? JSON.parse(batch.quality_json) : [];
  const reconDiffDebit = batch.source_total_debit != null && batch.imported_total_debit != null
    ? Math.round((batch.source_total_debit - batch.imported_total_debit) * 100) / 100 : null;
  const reconDiffCredit = batch.source_total_credit != null && batch.imported_total_credit != null
    ? Math.round((batch.source_total_credit - batch.imported_total_credit) * 100) / 100 : null;

  // ---------------- server actions ----------------
  async function setType(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const t = String(formData.get("type") || "") as ImportFileType;
    const r = setConfirmedType({ batchId: params.id, confirmedType: t, userId: admin.sub });
    if (isImportError(r)) redirect(`/imports/${params.id}?error=${encodeURIComponent(r.error)}`);
    redirect(`/imports/${params.id}`);
  }

  async function applyTemplate(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const templateId = String(formData.get("templateId") || "");
    const t = String(formData.get("type") || "") as ImportFileType;
    const tpl = listMappingTemplates(t).find((x) => x.id === templateId);
    if (!tpl) redirect(`/imports/${params.id}?error=${encodeURIComponent("القالب غير موجود")}`);
    const r = saveMapping({ batchId: params.id, confirmedType: t, mapping: JSON.parse(tpl!.mapping_json), userId: admin.sub });
    if (isImportError(r)) redirect(`/imports/${params.id}?error=${encodeURIComponent(r.error)}`);
    redirect(`/imports/${params.id}?ok=${encodeURIComponent("تم تطبيق القالب")}`);
  }

  async function saveMappingAction(formData: FormData) {
    "use server";
    const admin = await requireExecutor();
    const t = String(formData.get("type") || "") as ImportFileType;
    const map: Record<string, string> = {};
    for (const f of fieldsForType(t)) {
      const v = String(formData.get(`map_${f.key}`) || "");
      if (v) map[f.key] = v;
    }
    const r = saveMapping({ batchId: params.id, confirmedType: t, mapping: map, userId: admin.sub });
    if (isImportError(r)) redirect(`/imports/${params.id}?error=${encodeURIComponent(r.error)}`);

    const saveAsTemplate = formData.get("saveAsTemplate");
    const templateName = String(formData.get("templateName") || "").trim();
    if (saveAsTemplate && templateName) {
      try {
        createMappingTemplate({ name: templateName, fileType: t, mapping: map, createdBy: admin.sub });
      } catch (e: any) {
        if (e?.code === "ERR_SQLITE_ERROR" && e?.errcode === 2067) {
          redirect(`/imports/${params.id}?error=${encodeURIComponent("يوجد قالب بنفس الاسم")}`);
        }
        throw e;
      }
    }
    redirect(`/imports/${params.id}?ok=${encodeURIComponent("تم حفظ ربط الأعمدة")}`);
  }

  async function commitAction() {
    "use server";
    const admin = await requireExecutor();
    const r = await runCommit({ batchId: params.id, userId: admin.sub });
    if (isImportError(r)) redirect(`/imports/${params.id}?error=${encodeURIComponent(r.error)}`);
    redirect(`/imports/${params.id}`);
  }

  const requiredKeys = currentType ? requiredFieldsForType(currentType).map((f) => f.key) : [];
  const mappingComplete = requiredKeys.every((k) => mapping[k]);

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-2 text-sm text-gray-400 mb-2">
        <Link href="/imports" className="hover:underline">استيراد البيانات</Link>
        <span>/</span>
        <span className="text-gray-600">{batch.file_name}</span>
      </div>
      <h1 className="text-2xl font-bold mb-4">{batch.file_name}</h1>

      {searchParams.error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>
      )}
      {searchParams.ok && (
        <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>
      )}

      {/* ---- Result banners ---- */}
      {batch.status === "BLOCKED" && (
        <div className="mb-6 rounded-xl border-2 border-red-300 bg-red-50 p-5">
          <div className="text-red-800 font-bold text-lg mb-1">⛔ BLOCKED — الاستيراد محظور</div>
          <p className="text-sm text-red-700">
            التسوية فشلت: إجمالي المصدر لا يساوي الإجمالي المستورد فعليًا في قاعدة البيانات. لم يتم اعتماد أي بيانات.
            صحّح الملف أو ربط الأعمدة ثم أعد الاستيراد.
          </p>
          <div className="mt-3 text-sm text-red-800 grid grid-cols-3 gap-2 max-w-lg">
            <div>إجمالي المصدر (مدين): <b>{fmtMoney(batch.source_total_debit)}</b></div>
            <div>المستورد (مدين): <b>{fmtMoney(batch.imported_total_debit)}</b></div>
            <div>الفرق: <b>{fmtMoney(reconDiffDebit)}</b></div>
            <div>إجمالي المصدر (دائن): <b>{fmtMoney(batch.source_total_credit)}</b></div>
            <div>المستورد (دائن): <b>{fmtMoney(batch.imported_total_credit)}</b></div>
            <div>الفرق: <b>{fmtMoney(reconDiffCredit)}</b></div>
          </div>
        </div>
      )}
      {batch.status === "COMMITTED" && (
        <div className="mb-6 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-5">
          <div className="text-emerald-800 font-bold text-lg mb-1">✓ تم الاستيراد والتسوية بنجاح</div>
          <p className="text-sm text-emerald-700">
            {batch.total_rows} صف مستورد. إجمالي المصدر يطابق الإجمالي المستورد (الفرق = 0). درجة الجودة: {batch.quality_score}%.
          </p>
          <div className="mt-2">
            <Link href="/trial-balance" className="text-sm text-navy underline">عرض ميزان المراجعة ←</Link>
          </div>
        </div>
      )}

      {/* ---- Detection ---- */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
        <h2 className="font-semibold mb-3">1. نوع الملف</h2>
        <p className="text-sm text-gray-600 mb-1">
          الاكتشاف التلقائي: <b>{TYPE_LABEL[batch.detected_type ?? "UNKNOWN"]}</b>
          {batch.detection_confidence != null && <span className="text-gray-400"> (ثقة {Math.round((batch.detection_confidence) * 100)}%)</span>}
        </p>
        <p className="text-xs text-gray-400 mb-4">{batch.detection_reason}</p>
        {isAdmin ? (
          <form action={setType} className="flex items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">تأكيد/تصحيح النوع يدويًا</label>
              <select name="type" defaultValue={currentType ?? ""} required className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="" disabled>اختر النوع</option>
                <option value="TRIAL_BALANCE">ميزان مراجعة</option>
                <option value="GENERAL_LEDGER">أستاذ عام</option>
              </select>
            </div>
            <button className="bg-gray-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">تعيين النوع</button>
          </form>
        ) : (
          <p className="text-sm text-gray-500">النوع المؤكَّد: {currentType ? TYPE_LABEL[currentType] : "—"}</p>
        )}
      </div>

      {/* ---- Preview ---- */}
      {preview && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h2 className="font-semibold mb-3">معاينة الملف (أول {preview.rows.length} صفوف)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border">
              <thead className="bg-gray-50 text-gray-500">
                <tr>{preview.headers.map((h) => <th key={h} className="text-right px-2 py-1 border whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="divide-x">
                    {preview!.headers.map((h) => <td key={h} className="px-2 py-1 border text-gray-700 whitespace-nowrap">{String(row[h] ?? "")}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Column mapping ---- */}
      {currentType && isAdmin && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h2 className="font-semibold mb-1">2. ربط الأعمدة ({TYPE_LABEL[currentType]})</h2>
          <p className="text-xs text-gray-400 mb-4">اربط كل حقل قياسي بالعمود المقابل في ملفك. الحقول المعلَّمة بـ * إلزامية.</p>

          {templates.length > 0 && (
            <form action={applyTemplate} className="flex items-end gap-3 mb-5 pb-5 border-b">
              <input type="hidden" name="type" value={currentType} />
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">تطبيق قالب محفوظ</label>
                <select name="templateId" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm min-w-48">
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <button className="bg-gray-100 text-gray-800 border rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-200">تطبيق</button>
            </form>
          )}

          <form action={saveMappingAction} className="space-y-3">
            <input type="hidden" name="type" value={currentType} />
            {fieldsForType(currentType).map((f) => {
              const required = requiredKeys.includes(f.key);
              return (
                <div key={f.key} className="grid grid-cols-2 gap-4 items-center">
                  <label className="text-sm text-gray-700">
                    {f.label} {required && <span className="text-red-500">*</span>}
                    <span className="text-gray-400 text-xs"> ({f.key})</span>
                  </label>
                  <select
                    name={`map_${f.key}`}
                    defaultValue={mapping[f.key] ?? ""}
                    required={required}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">— تجاهل —</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              );
            })}

            <div className="flex items-center gap-3 pt-4 border-t mt-4">
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input type="checkbox" name="saveAsTemplate" value="1" /> حفظ كقالب باسم:
              </label>
              <input name="templateName" placeholder="اسم القالب" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
            </div>

            <div className="pt-2">
              <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">حفظ ربط الأعمدة</button>
            </div>
          </form>
        </div>
      )}

      {/* ---- Validation + reconciliation + commit ---- */}
      {currentType && isAdmin && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <h2 className="font-semibold mb-1">3. التحقق والتسوية والاستيراد</h2>
          <p className="text-xs text-gray-400 mb-4">
            يشغّل التحقق (توازن مدين=دائن، حسابات مفقودة، مبالغ/تواريخ غير صالحة، تكرار)، ثم يستورد ضمن معاملة واحدة،
            ثم يسوّي إجمالي المصدر مقابل المستورد فعليًا. إن اختلفا يُحظر الاستيراد ولا تُعتمد البيانات.
          </p>
          {!mappingComplete && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">
              أكمل ربط الحقول الإلزامية (رمز الحساب، مدين، دائن) واحفظها قبل الاستيراد.
            </p>
          )}
          <form action={commitAction}>
            <button
              disabled={!mappingComplete}
              className="bg-emerald-600 text-white rounded-lg px-5 py-2.5 text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {batch.status === "COMMITTED" || batch.status === "BLOCKED" ? "إعادة التحقق والاستيراد" : "تشغيل التحقق والاستيراد"}
            </button>
          </form>

          {qualityChecks.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm text-gray-500">درجة الجودة:</span>
                <span className={`text-lg font-bold ${(batch.quality_score ?? 0) >= 90 ? "text-emerald-600" : (batch.quality_score ?? 0) >= 60 ? "text-amber-600" : "text-red-600"}`}>
                  {batch.quality_score}%
                </span>
              </div>
              <div className="space-y-2">
                {qualityChecks.map((c) => (
                  <div key={c.id} className="flex items-start gap-3 text-sm">
                    <span className={`mt-0.5 inline-block w-16 shrink-0 text-center text-xs rounded px-1 py-0.5 ${
                      c.status === "PASS" ? "bg-emerald-100 text-emerald-700" : c.status === "WARN" ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"
                    }`}>{c.status}</span>
                    <div>
                      <div className="text-gray-700">{c.label}</div>
                      <div className="text-gray-500 text-xs">{c.detail}
                        {c.affectedRows.length > 0 && <span> — صفوف: {c.affectedRows.join("، ")}{c.affectedCount > c.affectedRows.length ? " …" : ""}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!isAdmin && <p className="text-sm text-gray-400">دورك (مراجع) للاطلاع فقط.</p>}
    </div>
  );
}
