import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findUserById } from "@/lib/repo";
import { changeUserRole, changeUserActive, isUserError } from "@/lib/user-actions";
import { z } from "zod";

export const runtime = "nodejs";

const PatchSchema = z.object({
  role: z.enum(["ADMIN", "AUDITOR", "EXECUTOR"]).optional(),
  active: z.boolean().optional(),
});

// PATCH /api/users/[id] — change role and/or enable/disable (ADMIN only)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  if (parsed.data.role === undefined && parsed.data.active === undefined) {
    return NextResponse.json({ error: "لا تغيير مطلوب" }, { status: 400 });
  }

  if (parsed.data.role !== undefined) {
    const r = changeUserRole({ userId: params.id, role: parsed.data.role, actorId: session.sub });
    if (isUserError(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  }
  if (parsed.data.active !== undefined) {
    const r = changeUserActive({ userId: params.id, active: parsed.data.active, actorId: session.sub });
    if (isUserError(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  }
  const updated = findUserById(params.id);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { password_hash, ...safe } = updated;
  return NextResponse.json({ user: safe });
}
