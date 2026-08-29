import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { listFindings, findingStatusCounts } from "@/lib/repo";
import { raiseFinding, isP5Error } from "@/lib/phase5-actions";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  return NextResponse.json({ findings: listFindings(companyId), statusCounts: findingStatusCounts(companyId) });
}

const CreateSchema = z.object({
  companyId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  procedureId: z.string().nullable().optional(),
  accountCode: z.string().nullable().optional(),
  recommendation: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = raiseFinding({ ...parsed.data, userId: session.sub });
  if (isP5Error(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ finding: r }, { status: 201 });
}
