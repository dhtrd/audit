// PRE-AUDIT OS — Phase 10 password management.
// Two flows: a user changing their own password (verifies the current
// one), and an admin resetting another user's password. The password
// itself is NEVER written to the audit log — only that a change happened.

import { findUserById, updateUserPassword, bumpTokenEpoch, writeAuditLog } from "./repo";
import { hashPassword, verifyPassword, createSession } from "./auth";

export type PwError = { error: string; code: number };
function err(error: string, code: number): PwError { return { error, code }; }
export function isPwError(x: unknown): x is PwError { return !!x && typeof x === "object" && "error" in (x as any); }

const MIN = 8;

/** A user changes their own password (must supply the current one). */
export async function changeOwnPassword(input: {
  userId: string; currentPassword: string; newPassword: string;
}): Promise<{ ok: true } | PwError> {
  const user = findUserById(input.userId);
  if (!user) return err("المستخدم غير موجود", 404);
  if (!input.newPassword || input.newPassword.length < MIN) return err("كلمة المرور الجديدة يجب ألا تقل عن ٨ أحرف", 400);
  if (!(await verifyPassword(input.currentPassword, user.password_hash))) return err("كلمة المرور الحالية غير صحيحة", 400);
  if (await verifyPassword(input.newPassword, user.password_hash)) return err("كلمة المرور الجديدة مطابقة للحالية", 400);
  const updated = updateUserPassword(input.userId, await hashPassword(input.newPassword))!;
  // The epoch bump invalidated ALL of this user's tokens (incl. the current
  // one). Re-issue the current session with the new epoch so the user who
  // just changed their own password stays logged in; other sessions die.
  await createSession({ sub: updated.id, name: updated.name, email: updated.email, role: updated.role, epoch: updated.token_epoch });
  writeAuditLog({ userId: input.userId, action: "PASSWORD_CHANGE", entityType: "User", entityId: input.userId });
  return { ok: true };
}

/** Terminate all of the user's sessions on other devices, keeping the
 *  current one alive (re-issued with the new epoch). */
export async function terminateAllSessions(input: { userId: string }): Promise<{ ok: true } | PwError> {
  const updated = bumpTokenEpoch(input.userId);
  if (!updated) return err("المستخدم غير موجود", 404);
  await createSession({ sub: updated.id, name: updated.name, email: updated.email, role: updated.role, epoch: updated.token_epoch });
  writeAuditLog({ userId: input.userId, action: "SESSIONS_TERMINATED", entityType: "User", entityId: input.userId });
  return { ok: true };
}

/** An admin resets another user's password. */
export async function adminResetPassword(input: {
  targetId: string; newPassword: string; actorId: string | null;
}): Promise<{ ok: true } | PwError> {
  const user = findUserById(input.targetId);
  if (!user) return err("المستخدم غير موجود", 404);
  if (!input.newPassword || input.newPassword.length < MIN) return err("كلمة المرور يجب ألا تقل عن ٨ أحرف", 400);
  updateUserPassword(input.targetId, await hashPassword(input.newPassword));
  writeAuditLog({ userId: input.actorId, action: "PASSWORD_RESET", entityType: "User", entityId: input.targetId });
  return { ok: true };
}
