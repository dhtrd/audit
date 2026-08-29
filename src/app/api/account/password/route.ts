import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { changeOwnPassword, isPwError } from "@/lib/password-actions";
import { z } from "zod";

export const runtime = "nodejs";

const Schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// POST /api/account/password — the logged-in user changes their own password
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = await changeOwnPassword({ userId: session.sub, ...parsed.data });
  if (isPwError(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ ok: true });
}
