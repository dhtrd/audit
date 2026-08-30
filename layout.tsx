import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession, getSession, destroySession } from "@/lib/auth";
import { writeAuditLog } from "@/lib/repo";

// Every page under (app) is per-user, session- and DB-backed — never static.
// Forcing dynamic stops `next build` from trying to prerender/collect these
// pages at build time (which needs no request/DB and can fail or OOM on some
// hosts), and it is the correct runtime behavior for an authenticated app.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  async function logout() {
    "use server";
    const s = await getSession();
    destroySession();
    if (s) writeAuditLog({ userId: s.sub, action: "LOGOUT", entityType: "User", entityId: s.sub });
    redirect("/login");
  }

  const navItems = [
    { href: "/dashboard", label: "لوحة التحكم" },
    { href: "/portfolio", label: "لوحة المحفظة" },
    { href: "/company", label: "الشركة" },
    { href: "/fiscal-years", label: "السنوات المالية" },
    { href: "/imports", label: "استيراد البيانات" },
    { href: "/trial-balance", label: "ميزان المراجعة" },
    { href: "/risk", label: "المخاطر والتحليلات" },
    { href: "/procedures", label: "الأدلة والإجراءات" },
    { href: "/findings", label: "الملاحظات" },
    { href: "/adjustments", label: "التسويات" },
    { href: "/reports", label: "التقارير والتصدير" },
    { href: "/audit-trail", label: "سجل التدقيق" },
    { href: "/account", label: "حسابي" },
    ...(session.role === "ADMIN" ? [{ href: "/users", label: "المستخدمون والصلاحيات" }] : []),
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 shrink-0 bg-navy text-white flex flex-col">
        <div className="p-5 border-b border-white/10">
          <div className="text-xl font-bold">PRE-AUDIT OS</div>
          <div className="text-xs text-white/60 mt-1">Phase 12 — Ops & Integrity</div>
        </div>
        <nav className="flex-1 p-3 space-y-1 text-sm">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-lg px-3 py-2 hover:bg-white/10 transition"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-white/10 text-sm">
          <div className="mb-2">
            {session.name}{" "}
            <span className="text-white/50">({session.role === "ADMIN" ? "مدير" : session.role === "EXECUTOR" ? "منفّذ" : "مراجع"})</span>
          </div>
          <form action={logout}>
            <button className="text-red-200 hover:text-red-100 text-xs">تسجيل الخروج</button>
          </form>
        </div>
      </aside>
      <main className="flex-1 p-8 bg-gray-50">{children}</main>
    </div>
  );
}
