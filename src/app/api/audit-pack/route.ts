import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCompany, writeAuditLog } from "@/lib/repo";
import { buildAuditPackWorkbook } from "@/lib/audit-pack";

export const runtime = "nodejs";

// GET /api/audit-pack?companyId= — download the consolidated Audit Pack (.xlsx)
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  const company = companyId ? getCompany(companyId) : undefined;
  if (!company) return NextResponse.json({ error: "الشركة غير موجودة" }, { status: 404 });

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  const wb = await buildAuditPackWorkbook(companyId!, generatedAt);
  const buffer = await wb.xlsx.writeBuffer();

  writeAuditLog({ userId: session.sub, action: "AUDIT_PACK_EXPORT", entityType: "Company", entityId: companyId, details: { generatedAt } });

  const fname = `audit-pack-${(company.legal_name || "company").replace(/[^\p{L}\p{N}_-]+/gu, "_")}.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
    },
  });
}
