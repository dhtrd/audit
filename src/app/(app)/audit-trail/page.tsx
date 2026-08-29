import { requireSession } from "@/lib/auth";
import { listAuditLogs } from "@/lib/repo";

const ACTION_LABEL: Record<string, string> = {
  LOGIN: "تسجيل دخول",
  LOGOUT: "تسجيل خروج",
  CREATE: "إنشاء",
  UPDATE: "تعديل",
};

export default async function AuditTrailPage() {
  await requireSession();
  const logs = listAuditLogs(200);

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">سجل التدقيق</h1>
      <p className="text-gray-500 text-sm mb-6">
        سجل غير قابل للحذف من داخل التطبيق — لا يوجد أي مسار (route) لحذف هذه السجلات.
      </p>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-right px-4 py-3">الوقت</th>
              <th className="text-right px-4 py-3">المستخدم</th>
              <th className="text-right px-4 py-3">الإجراء</th>
              <th className="text-right px-4 py-3">الكيان</th>
              <th className="text-right px-4 py-3">تفاصيل</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-gray-400 text-center">
                  لا توجد أحداث مسجَّلة بعد.
                </td>
              </tr>
            )}
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{log.created_at}</td>
                <td className="px-4 py-3">{log.user_name ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className="inline-block rounded-full bg-navyLight text-navy text-xs px-2 py-1">
                    {ACTION_LABEL[log.action] ?? log.action}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  {log.entity_type}
                  {log.entity_id ? ` #${log.entity_id.slice(0, 8)}` : ""}
                </td>
                <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">{log.details ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
