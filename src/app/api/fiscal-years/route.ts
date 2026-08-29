import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createFiscalYear, listFiscalYears, writeAuditLog } from "@/lib/repo";
import { z } from "zod";

export const runtime = "nodejs";

const CreateFiscalYearSchema = z.object({
  companyId: z.string().min(1),
  year: z.number().int(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
});

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId") ?? undefined;
  return NextResponse.json({ fiscalYears: listFiscalYears(companyId) });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateFiscalYearSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  try {
    const fy = createFiscalYear(parsed.data);
    writeAuditLog({ userId: session.sub, action: "CREATE", entityType: "FiscalYear", entityId: fy.id, details: parsed.data });
    return NextResponse.json({ fiscalYear: fy }, { status: 201 });
  } catch (err: any) {
    if (err?.code === "ERR_SQLITE_ERROR" && err?.errcode === 2067) {
      return NextResponse.json(
        { error: `السنة المالية ${parsed.data.year} موجودة بالفعل لهذه الشركة` },
        { status: 409 }
      );
    }
    throw err;
  }
}
