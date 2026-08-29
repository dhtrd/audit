import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, requireAdmin } from "@/lib/auth";
import { createCompany, listCompanies, writeAuditLog } from "@/lib/repo";

export default async function CompanyPage() {
  const session = await requireSession();
  const companies = listCompanies();

  async function create(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const legalName = String(formData.get("legalName") || "").trim();
    if (!legalName) redirect("/company?error=1");

    const company = createCompany({
      legalName,
      legalNameAr: String(formData.get("legalNameAr") || "") || null,
      commercialRegistration: String(formData.get("commercialRegistration") || "") || null,
      vatNumber: String(formData.get("vatNumber") || "") || null,
      currency: String(formData.get("currency") || "SAR"),
    });
    writeAuditLog({ userId: admin.sub, action: "CREATE", entityType: "Company", entityId: company.id, details: { legalName } });
    redirect("/company");
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">الشركة</h1>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y mb-8">
        {companies.length === 0 && (
          <div className="p-6 text-sm text-gray-400">لا توجد شركة مسجَّلة بعد.</div>
        )}
        {companies.map((c) => (
          <div key={c.id} className="p-5 flex items-center justify-between">
            <div>
              <div className="font-medium">{c.legal_name}</div>
              {c.legal_name_ar && <div className="text-sm text-gray-500">{c.legal_name_ar}</div>}
              <div className="text-xs text-gray-400 mt-1">
                {c.commercial_registration ? `س.ت: ${c.commercial_registration}` : "بلا سجل تجاري"} ·{" "}
                {c.vat_number ? `ض.ق.م: ${c.vat_number}` : "بلا رقم ضريبي"} · {c.currency}
              </div>
            </div>
            {session.role === "ADMIN" && (
              <Link href={`/company/${c.id}/edit`} className="text-sm text-navy hover:underline">
                تعديل
              </Link>
            )}
          </div>
        ))}
      </div>

      {session.role === "ADMIN" ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold mb-4">إضافة شركة</h2>
          <form action={create} className="grid grid-cols-2 gap-4">
            <Field name="legalName" label="الاسم القانوني (إنجليزي)" required />
            <Field name="legalNameAr" label="الاسم بالعربية" />
            <Field name="commercialRegistration" label="السجل التجاري" />
            <Field name="vatNumber" label="الرقم الضريبي" />
            <Field name="currency" label="العملة" defaultValue="SAR" />
            <div className="col-span-2">
              <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
                حفظ
              </button>
            </div>
          </form>
        </div>
      ) : (
        <p className="text-sm text-gray-400">دورك (مراجع) للاطلاع فقط — إضافة/تعديل الشركة متاح للمدير.</p>
      )}
    </div>
  );
}

function Field({
  name,
  label,
  required,
  defaultValue,
}: {
  name: string;
  label: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        name={name}
        required={required}
        defaultValue={defaultValue}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy"
      />
    </div>
  );
}
