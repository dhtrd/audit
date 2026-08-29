import { NextResponse } from "next/server";
import { getSession, destroySession } from "@/lib/auth";
import { writeAuditLog } from "@/lib/repo";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSession();
  destroySession();
  if (session) {
    writeAuditLog({ userId: session.sub, action: "LOGOUT", entityType: "User", entityId: session.sub });
  }
  return NextResponse.json({ ok: true });
}
