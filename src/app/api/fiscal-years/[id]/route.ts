import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFiscalYear, updateFiscalYearStatus, writeAuditLog } from "@/lib/repo";
import { z } from "zod";

export const runtime = "nodejs";

const UpdateSchema = z.object({
  status: z.enum(["DRAFT", "IN_PROGRESS", "CLOSED"]),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const existing = getFiscalYear(params.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = updateFiscalYearStatus(params.id, parsed.data.status);
  writeAuditLog({ userId: session.sub, action: "UPDATE", entityType: "FiscalYear", entityId: params.id, details: parsed.data });
  return NextResponse.json({ fiscalYear: updated });
}
