import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listTrialBalances } from "@/lib/repo";

export const runtime = "nodejs";

// GET /api/trial-balance?companyId=...  — the imported trial balance rows
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  const rows = listTrialBalances(companyId);
  const totals = rows.reduce(
    (t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }),
    { debit: 0, credit: 0 }
  );
  return NextResponse.json({
    rows,
    totals: { debit: Math.round(totals.debit * 100) / 100, credit: Math.round(totals.credit * 100) / 100 },
  });
}
