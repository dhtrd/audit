import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { hashPassword } from "@/lib/auth";
import { createUser, findUserByEmail, listUsers, writeAuditLog, type Role } from "@/lib/repo";
import { changeUserRole, changeUserActive, isUserError } from "@/lib/user-actions";
import { adminResetPassword, isPwError } from "@/lib/password-actions";

const ROLE_LABEL: Record<string, string> = { ADMIN: "مدير", AUDITOR: "مراجع", EXECUTOR: "منفّذ" };

export default async function UsersPage({ searchParams }: { searchParams: { error?: string; ok?: string } }) {
  const admin = await requireAdmin();
  const users = listUsers();

  async function editUser(formData: FormData) {
    "use server";
    const current = await requireAdmin();
    const userId = String(formData.get("userId") || "");
    const role = String(formData.get("role") || "") as Role;
    const active = String(formData.get("active") || "1") === "1";
    const r1 = changeUserRole({ userId, role, actorId: current.sub });
    if (isUserError(r1)) redirect(`/users?error=${encodeURIComponent(r1.error)}`);
    const r2 = changeUserActive({ userId, active, actorId: current.sub });
    if (isUserError(r2)) redirect(`/users?error=${encodeURIComponent(r2.error)}`);
    redirect(`/users?ok=${encodeURIComponent("تم تحديث المستخدم")}`);
  }

  async function resetPassword(formData: FormData) {
    "use server";
    const current = await requireAdmin();
    const userId = String(formData.get("userId") || "");
    const newPassword = String(formData.get("newPassword") || "");
    const r = await adminResetPassword({ targetId: userId, newPassword, actorId: current.sub });
    if (isPwError(r)) redirect(`/users?error=${encodeURIComponent(r.error)}`);
    redirect(`/users?ok=${encodeURIComponent("تم إعادة تعيين كلمة المرور")}`);
  }

  async function create(formData: FormData) {
    "use server";
    const current = await requireAdmin();
    const name = String(formData.get("name") || "").trim();
    const email = String(formData.get("email") || "").trim().toLowerCase();
    const password = String(formData.get("password") || "");
    const role = String(formData.get("role") || "AUDITOR") as "ADMIN" | "AUDITOR" | "EXECUTOR";

    if (!name || !email || password.length < 8) redirect("/users?error=1");
    if (findUserByEmail(email)) redirect("/users?error=exists");

    const passwordHash = await hashPassword(password);
    const user = createUser({ name, email, passwordHash, role });
    writeAuditLog({ userId: current.sub, action: "CREATE", entityType: "User", entityId: user.id, details: { email, role } });
    redirect("/users");
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold mb-6">المستخدمون والصلاحيات</h1>

      {searchParams.error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{searchParams.error}</div>}
      {searchParams.ok && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{searchParams.ok}</div>}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="text-right px-4 py-3">الاسم</th>
              <th className="text-right px-4 py-3">البريد الإلكتروني</th>
              <th className="text-right px-4 py-3">الدور والحالة</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 whitespace-nowrap">
                  {u.name} {u.id === admin.sub && <span className="text-xs text-gray-400">(أنت)</span>}
                  {u.active === 0 && <span className="ms-2 text-xs text-red-600">معطَّل</span>}
                </td>
                <td className="px-4 py-3 text-gray-500">{u.email}</td>
                <td className="px-4 py-3" colSpan={2}>
                  <form action={editUser} className="flex items-center gap-2 flex-wrap">
                    <input type="hidden" name="userId" value={u.id} />
                    <select name="role" defaultValue={u.role} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                      <option value="AUDITOR">مراجع</option>
                      <option value="EXECUTOR">منفّذ</option>
                      <option value="ADMIN">مدير</option>
                    </select>
                    <select name="active" defaultValue={u.active === 0 ? "0" : "1"} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                      <option value="1">نشط</option>
                      <option value="0">معطَّل</option>
                    </select>
                    <button className="bg-gray-800 text-white rounded-lg px-3 py-1.5 text-xs hover:opacity-90">حفظ</button>
                  </form>
                  <form action={resetPassword} className="flex items-center gap-2 flex-wrap mt-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <input name="newPassword" type="password" required minLength={8} placeholder="كلمة مرور جديدة" className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                    <button className="bg-gray-100 border text-gray-700 rounded-lg px-3 py-1.5 text-xs hover:bg-gray-200">إعادة تعيين كلمة المرور</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold mb-4">إضافة مستخدم</h2>
        <form action={create} className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">الاسم</label>
            <input name="name" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">البريد الإلكتروني</label>
            <input name="email" type="email" required className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">كلمة المرور (٨ أحرف فأكثر)</label>
            <input name="password" type="password" required minLength={8} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">الدور</label>
            <select name="role" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="AUDITOR">مراجع (اطلاع فقط)</option>
              <option value="EXECUTOR">منفّذ (تنفيذ التدقيق دون اعتماد أو حوكمة)</option>
              <option value="ADMIN">مدير (صلاحيات كاملة)</option>
            </select>
          </div>
          <div className="col-span-2">
            <button className="bg-navy text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90">
              إضافة مستخدم
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
