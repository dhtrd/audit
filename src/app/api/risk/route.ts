import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getMateriality } from "@/lib/repo";
import { analyzeRisk } from "@/lib/risk";

export const runtime = "nodejs";

// GET /api/risk?companyId=&fiscalYearId=
// Runs the analytical procedures live against the imported TB/GL data.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  const fiscalYearId = req.nextUrl.searchParams.get("fiscalYearId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });

  // fiscal-year-specific materiality wins; else the company-wide default
  const mat = getMateriality(companyId, fiscalYearId ?? null) ?? getMateriality(companyId, null);
  const report = analyzeRisk(companyId, mat?.amount ?? null);
  return NextResponse.json({ report, materialityBasis: mat?.basis_note ?? null });
}
