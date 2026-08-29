import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listGeneralLedgerByAccount } from "@/lib/repo";

export const runtime = "nodejs";

// GET /api/general-ledger?companyId=...&accountCode=...  — GL entries for one
// account (the real drill-down target from the trial balance, via SQL).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  const accountCode = req.nextUrl.searchParams.get("accountCode");
  if (!companyId || !accountCode) return NextResponse.json({ error: "companyId و accountCode مطلوبان" }, { status: 400 });
  const rows = listGeneralLedgerByAccount(companyId, accountCode);
  const totals = rows.reduce(
    (t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }),
    { debit: 0, credit: 0 }
  );
  return NextResponse.json({
    rows,
    totals: { debit: Math.round(totals.debit * 100) / 100, credit: Math.round(totals.credit * 100) / 100 },
  });
}
