import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { listAdjustments, listAdjustmentLines, adjustmentStatusCounts } from "@/lib/repo";
import { proposeAdjustment, isP5Error } from "@/lib/phase5-actions";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  const adjustments = listAdjustments(companyId).map((a) => ({ ...a, lines: listAdjustmentLines(a.id) }));
  return NextResponse.json({ adjustments, statusCounts: adjustmentStatusCounts(companyId) });
}

const LineSchema = z.object({
  accountCode: z.string().min(1),
  accountName: z.string().nullable().optional(),
  debit: z.number().nonnegative().optional().default(0),
  credit: z.number().nonnegative().optional().default(0),
});
const CreateSchema = z.object({
  companyId: z.string().min(1),
  description: z.string().min(1),
  findingId: z.string().nullable().optional(),
  lines: z.array(LineSchema).min(2),
});

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = proposeAdjustment({ ...parsed.data, userId: session.sub });
  if (isP5Error(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ adjustment: r }, { status: 201 });
}
