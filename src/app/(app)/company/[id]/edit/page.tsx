import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { getCompany, updateCompany, writeAuditLog } from "@/lib/repo";

export default async function EditCompanyPage({ params }: { params: { id: string } }) {
  await requireAdmin();
  const company = getCompany(params.id);
  if (!company) notFound();

  async function save(formData: FormData) {
    "use server";
    const admin = await requireAdmin();
    const updated = updateCompany(params.id, {
      legalName: String(formData.get("legalName") || company!.legal_name),
      legalNameAr: String(formData.get("legalNameAr") || "") || null,
      commercialRegistration: String(formData.get("commercialRegistration") || "") || null,
      vatNumber: String(formData.get("vatNumber") || "") || null,
      currency: String(formData.get("currency") || "SAR"),
    });
    writeAuditLog({
      userId: admin.sub,
      action: "UPDATE",
      entityType: "Company",
      entityId: params.id,
      details: updated,
    });
    redirect("/company");
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">تعديل بيانات الشركة</h1>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <form action={save} className="grid grid-cols-2 gap-4">
          <Field name="legalName" label="الاسم القانوني (إنجليزي)" defaultValue={company.legal_name} required />
          <Field name="legalNameAr" label="الاسم بالعربية" defaultValue={company.legal_name_ar ?? ""} />
          <Field
            name="commercialRegistration"
            label="السجل التجاري"
            defaultValue={company.commercial_registration ?? ""}
          />
          <Field name="vatNumber" label="الرقم الضريبي" defaultValue={company.vat_number ?? ""} />
          <Field name="currency" label="العملة" defaultValue={company.currency} />
          <div className="col-span-2">
            <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
              حفظ التعديلات
            </button>
          </div>
        </form>
      </div>
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
