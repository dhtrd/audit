import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeFullReadiness } from "@/lib/readiness2";

export const runtime = "nodejs";

// GET /api/readiness?companyId= — the full weighted Audit Readiness Score
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  return NextResponse.json({ readiness: computeFullReadiness(companyId) });
}
