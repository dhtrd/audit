import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { getCompany } from "@/lib/repo";
import { generateProcedures } from "@/lib/procedures";

export const runtime = "nodejs";

// POST /api/procedures/generate?companyId= — auto-generate procedures from the current risk flags (ADMIN)
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId || !getCompany(companyId)) return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });
  const result = generateProcedures(companyId, session.sub);
  return NextResponse.json({ created: result.created.length, procedures: result.created }, { status: 201 });
}
