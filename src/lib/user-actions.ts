// PRE-AUDIT OS — Phase 9 user administration (role change + enable/disable).
// Guards against locking everyone out: the last ACTIVE admin can neither be
// demoted nor disabled. Every change is audit-logged. ADMIN-only (enforced
// by the callers).

import {
  type Role, findUserById, countActiveAdmins, updateUserRole, setUserActive, writeAuditLog,
} from "./repo";

export type UserError = { error: string; code: number };
function err(error: string, code: number): UserError { return { error, code }; }
export function isUserError(x: unknown): x is UserError { return !!x && typeof x === "object" && "error" in (x as any); }

const ROLES: Role[] = ["ADMIN", "AUDITOR", "EXECUTOR"];

export function changeUserRole(input: { userId: string; role: Role; actorId: string | null }): { ok: true } | UserError {
  const target = findUserById(input.userId);
  if (!target) return err("المستخدم غير موجود", 404);
  if (!ROLES.includes(input.role)) return err("دور غير صالح", 400);
  // prevent demoting the last active admin
  if (target.role === "ADMIN" && target.active === 1 && input.role !== "ADMIN" && countActiveAdmins() <= 1) {
    return err("لا يمكن تخفيض آخر مدير نشط — عيّن مديرًا آخر أولًا", 409);
  }
  if (target.role === input.role) return { ok: true }; // no-op
  updateUserRole(input.userId, input.role);
  writeAuditLog({ userId: input.actorId, action: "USER_ROLE_CHANGE", entityType: "User", entityId: input.userId, details: { from: target.role, to: input.role } });
  return { ok: true };
}

export function changeUserActive(input: { userId: string; active: boolean; actorId: string | null }): { ok: true } | UserError {
  const target = findUserById(input.userId);
  if (!target) return err("المستخدم غير موجود", 404);
  // prevent disabling the last active admin
  if (!input.active && target.role === "ADMIN" && target.active === 1 && countActiveAdmins() <= 1) {
    return err("لا يمكن تعطيل آخر مدير نشط", 409);
  }
  if ((target.active === 1) === input.active) return { ok: true }; // no-op
  setUserActive(input.userId, input.active);
  writeAuditLog({ userId: input.actorId, action: input.active ? "USER_ENABLE" : "USER_DISABLE", entityType: "User", entityId: input.userId, details: {} });
  return { ok: true };
}
