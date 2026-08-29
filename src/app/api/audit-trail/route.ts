import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listAuditLogs } from "@/lib/repo";

export const runtime = "nodejs";

// Intentionally: GET only. No PATCH/DELETE handler exists in this file or
// anywhere else in the API — audit logs cannot be altered via the API,
// matching invariant #7 in the spec.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  return NextResponse.json({ logs: listAuditLogs(limit) });
}
