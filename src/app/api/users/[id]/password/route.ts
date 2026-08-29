import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { adminResetPassword, isPwError } from "@/lib/password-actions";
import { z } from "zod";

export const runtime = "nodejs";

const Schema = z.object({ newPassword: z.string().min(8) });

// POST /api/users/[id]/password — admin resets another user's password
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = await adminResetPassword({ targetId: params.id, newPassword: parsed.data.newPassword, actorId: session.sub });
  if (isPwError(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ ok: true });
}
