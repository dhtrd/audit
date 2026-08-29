import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCompany, updateCompany, writeAuditLog } from "@/lib/repo";
import { z } from "zod";

export const runtime = "nodejs";

const UpdateCompanySchema = z.object({
  legalName: z.string().min(1).optional(),
  legalNameAr: z.string().nullable().optional(),
  commercialRegistration: z.string().nullable().optional(),
  vatNumber: z.string().nullable().optional(),
  currency: z.string().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const existing = getCompany(params.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = UpdateCompanySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = updateCompany(params.id, parsed.data);
  writeAuditLog({ userId: session.sub, action: "UPDATE", entityType: "Company", entityId: params.id, details: parsed.data });
  return NextResponse.json({ company: updated });
}
