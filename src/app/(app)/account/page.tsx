import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { changeOwnPassword, terminateAllSessions, isPwError } from "@/lib/password-actions";

const ROLE_LABEL: Record<string, string> = { ADMIN: "مدير", AUDITOR: "مراجع", EXECUTOR: "منفّذ" };

export default async function AccountPage({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  const session = await requireSession();

  async function changePassword(formData: FormData) {
    "use server";
    const s = await requireSession();
    const currentPassword = String(formData.get("currentPassword") || "");
    const newPassword = String(formData.get("newPassword") || "");
    const confirm = String(formData.get("confirm") || "");
    if (newPassword !== confirm) redirect(`/account?error=${encodeURIComponent("كلمتا المرور غير متطابقتين")}`);
    if (newPassword.length < 8) redirect(`/account?error=${encodeURIComponent("كلمة المرور يجب ألا تقل عن ٨ أحرف")}`);
    const r = await changeOwnPassword({ userId: s.sub, currentPassword, newPassword });
    if (isPwError(r)) redirect(`/account?error=${encodeURIComponent(r.error)}`);
    redirect(`/account?ok=${encodeURIComponent("تم تغيير كلمة المرور")}`);
  }

  async function logoutAll() {
    "use server";
    const s = await requireSession();
    await terminateAllSessions({ userId: s.sub });
    redirect(`/account?ok=${encodeURIComponent("تم إنهاء كل الجلسات الأخرى")}`);
  }

  return (
    <div className="max-w-lg">
      <h1 className="text-2xl font-bold mb-1">حسابي</h1>
      <p className="text-gray-500 text-sm mb-6">{session.name} — {session.email} ({ROLE_LABEL[session.role] ?? session.role})</p>

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold mb-4">تغيير كلمة المرور</h2>
        <form action={changePassword} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">كلمة المرور الحالية</label>
            <input name="currentPassword" type="password" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">كلمة المرور الجديدة (٨ أحرف فأكثر)</label>
            <input name="newPassword" type="password" required minLength={8} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">تأكيد كلمة المرور الجديدة</label>
            <input name="confirm" type="password" required minLength={8} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">تغيير كلمة المرور</button>
        </form>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 mt-6">
        <h2 className="font-semibold mb-1">الجلسات</h2>
        <p className="text-xs text-gray-500 mb-4">إنهاء جلساتك على جميع الأجهزة الأخرى مع إبقاء هذه الجلسة نشطة.</p>
        <form action={logoutAll}>
          <button className="bg-gray-100 border text-gray-800 rounded-lg px-4 py-2 text-sm font-medium hover:bg-gray-200">إنهاء كل الجلسات الأخرى</button>
        </form>
      </div>
    </div>
  );
}
