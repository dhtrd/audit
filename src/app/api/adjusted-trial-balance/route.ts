import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { adjustedTrialBalance } from "@/lib/repo";

export const runtime = "nodejs";

// GET /api/adjusted-trial-balance?companyId= — imported TB + APPROVED adjustments per account
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  const rows = adjustedTrialBalance(companyId);
  const totals = rows.reduce((t, r) => ({
    tbDebit: t.tbDebit + r.tb_debit, tbCredit: t.tbCredit + r.tb_credit,
    adjDebit: t.adjDebit + r.adj_debit, adjCredit: t.adjCredit + r.adj_credit,
  }), { tbDebit: 0, tbCredit: 0, adjDebit: 0, adjCredit: 0 });
  return NextResponse.json({ rows, totals });
}
