import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getMateriality } from "@/lib/repo";
import { saveMateriality, isRiskError } from "@/lib/risk-actions";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/materiality?companyId=&fiscalYearId=
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  const fiscalYearId = req.nextUrl.searchParams.get("fiscalYearId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  return NextResponse.json({ materiality: getMateriality(companyId, fiscalYearId ?? null) ?? null });
}

const SetSchema = z.object({
  companyId: z.string().min(1),
  fiscalYearId: z.string().nullable().optional(),
  amount: z.number().positive(),
  basisNote: z.string().nullable().optional(),
});

// POST /api/materiality — set materiality (ADMIN)
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = SetSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const result = saveMateriality({ ...parsed.data, userId: session.sub });
  if (isRiskError(result)) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ materiality: result }, { status: 201 });
}
