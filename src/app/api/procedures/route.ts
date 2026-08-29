import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { listProcedures, procedureStatusCounts } from "@/lib/repo";
import { suggestProcedures, computeCoverage } from "@/lib/procedures";
import { createManualProcedure, isProcError } from "@/lib/procedure-actions";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/procedures?companyId= — list + status counts + coverage + suggestion count
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  return NextResponse.json({
    procedures: listProcedures(companyId),
    statusCounts: procedureStatusCounts(companyId),
    coverage: computeCoverage(companyId),
    suggestionCount: suggestProcedures(companyId).length,
  });
}

const CreateSchema = z.object({
  companyId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  accountCode: z.string().nullable().optional(),
});

// POST /api/procedures — create a manual procedure (ADMIN)
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = createManualProcedure({ ...parsed.data, userId: session.sub });
  if (isProcError(result)) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ procedure: result }, { status: 201 });
}
