import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { terminateAllSessions, isPwError } from "@/lib/password-actions";

export const runtime = "nodejs";

// POST /api/account/logout-all — invalidate all of the user's other sessions
export async function POST(_req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await terminateAllSessions({ userId: session.sub });
  if (isPwError(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ ok: true });
}
