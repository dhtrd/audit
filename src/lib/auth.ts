import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "./repo";
import { findUserByEmail, findUserById, writeAuditLog } from "./repo";

const SESSION_COOKIE = "pao_session";
const secretKey = () => new TextEncoder().encode(process.env.JWT_SECRET || "change-me-in-.env-please");

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface SessionPayload {
  sub: string; // user id
  name: string;
  email: string;
  role: Role;
}

export async function createSession(payload: SessionPayload & { epoch: number }) {
  // The signed token carries only the user id + token epoch; identity and
  // role are always resolved fresh from the DB in getSession so changes
  // take effect immediately.
  const token = await new SignJWT({ sub: payload.sub, epoch: payload.epoch })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secretKey());

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
}

export function destroySession() {
  cookies().delete(SESSION_COOKIE);
}

export async function getSession(): Promise<SessionPayload | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const sub = payload.sub as string;
    const epoch = (payload.epoch as number) ?? 0;
    // Resolve the live user: reject if gone, disabled, or the token epoch is
    // stale (role/password changed, or the account was disabled) — immediate
    // session invalidation. Identity + role are returned fresh from the DB.
    const user = findUserById(sub);
    if (!user || user.active === 0 || user.token_epoch !== epoch) return null;
    return { sub: user.id, name: user.name, email: user.email, role: user.role };
  } catch {
    return null;
  }
}

/** Shared by the /login server action and POST /api/auth/login — one source of truth. */
export async function attemptLogin(email: string, password: string): Promise<{ ok: true; session: SessionPayload } | { ok: false; reason: string }> {
  const user = findUserByEmail(email.trim().toLowerCase());
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return { ok: false, reason: "invalid_credentials" };
  }
  if (user.active === 0) {
    return { ok: false, reason: "disabled" };
  }
  const session: SessionPayload = { sub: user.id, name: user.name, email: user.email, role: user.role };
  await createSession({ ...session, epoch: user.token_epoch });
  writeAuditLog({ userId: user.id, action: "LOGIN", entityType: "User", entityId: user.id });
  return { ok: true, session };
}

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await requireSession();
  if (session.role !== "ADMIN") redirect("/dashboard?error=forbidden");
  return session;
}

// ---- Separation of duties (Phase 8) ----
// EXECUTOR performs audit work (imports, procedures, evidence, findings,
// proposing adjustments) but NOT governance (companies, fiscal years,
// users, materiality) nor approvals (adjustment approval, management
// review) — those stay ADMIN-only. AUDITOR remains read-only.
export function canExecute(role: Role): boolean {
  return role === "ADMIN" || role === "EXECUTOR";
}

/** Gate for audit-execution write paths (ADMIN or EXECUTOR). */
export async function requireExecutor(): Promise<SessionPayload> {
  const session = await requireSession();
  if (!canExecute(session.role)) redirect("/dashboard?error=forbidden");
  return session;
}
