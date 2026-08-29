// Creates the first ADMIN user. Runs (a) via `npm run db:seed` for local/CLI,
// and (b) automatically on server startup (see src/instrumentation.ts) so a
// hosted deployment has a working login immediately — no shell access needed.
// There is no public sign-up route by design (this is an internal tool).
import { createUser, findUserByEmail } from "./repo";
import { hashPassword } from "./auth";

/**
 * Ensure the seed ADMIN exists. Idempotent: if a user with the seed email is
 * already present, does nothing. Safe to call on every boot.
 * Returns a short status for logging.
 */
export async function ensureSeedAdmin(): Promise<{ created: boolean; email: string }> {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@company.local";
  const password = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";
  const name = process.env.SEED_ADMIN_NAME || "مدير النظام";

  const existing = findUserByEmail(email);
  if (existing) return { created: false, email };

  const passwordHash = await hashPassword(password);
  const user = createUser({ name, email, passwordHash, role: "ADMIN" });
  return { created: true, email: user.email };
}

// CLI entry point: `npm run db:seed`
async function main() {
  const r = await ensureSeedAdmin();
  if (r.created) {
    console.log("تم إنشاء حساب المدير:");
    console.log(`  البريد الإلكتروني: ${r.email}`);
    console.log(`  كلمة المرور: ${process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!"}`);
    console.log("  (غيّر كلمة المرور بعد أول تسجيل دخول)");
  } else {
    console.log(`المستخدم موجود بالفعل: ${r.email}`);
  }
}

// Only run main() when executed directly as a script, not when imported.
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  main();
}
