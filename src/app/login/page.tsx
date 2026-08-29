import { redirect } from "next/navigation";
import { getSession, attemptLogin } from "@/lib/auth";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const session = await getSession();
  if (session) redirect("/dashboard");

  async function login(formData: FormData) {
    "use server";
    const email = String(formData.get("email") || "");
    const password = String(formData.get("password") || "");
    const result = await attemptLogin(email, password);
    if (!result.ok) {
      redirect(result.reason === "disabled" ? "/login?error=disabled" : "/login?error=1");
    }
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-navy px-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-lg p-8">
        <div className="text-center mb-6">
          <div className="text-2xl font-bold text-navy">PRE-AUDIT OS</div>
          <div className="text-sm text-gray-500 mt-1">منصة التدقيق الداخلي التمهيدي</div>
        </div>

        {searchParams.error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {searchParams.error === "disabled" ? "هذا الحساب معطَّل — تواصل مع المدير." : "البريد الإلكتروني أو كلمة المرور غير صحيحة."}
          </div>
        )}

        <form action={login} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="email">
              البريد الإلكتروني
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy"
              placeholder="admin@company.local"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="password">
              كلمة المرور
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy"
            />
          </div>
          <button
            type="submit"
            className="w-full bg-navy text-white rounded-lg py-2 text-sm font-medium hover:opacity-90"
          >
            تسجيل الدخول
          </button>
        </form>

        <p className="text-xs text-gray-400 mt-6 text-center">
          لا يوجد تسجيل عام — الحساب الأول يُنشأ عبر: <code className="bg-gray-100 px-1 rounded">npm run db:seed</code>
        </p>
      </div>
    </div>
  );
}
