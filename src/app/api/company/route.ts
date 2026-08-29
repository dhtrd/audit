import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createCompany, listCompanies, writeAuditLog } from "@/lib/repo";
import { z } from "zod";

export const runtime = "nodejs";

const CreateCompanySchema = z.object({
  legalName: z.string().min(1),
  legalNameAr: z.string().nullable().optional(),
  commercialRegistration: z.string().nullable().optional(),
  vatNumber: z.string().nullable().optional(),
  currency: z.string().optional(),
});

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ companies: listCompanies() });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") {
    return NextResponse.json({ error: "forbidden — admin role required" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const parsed = CreateCompanySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const company = createCompany(parsed.data);
  writeAuditLog({ userId: session.sub, action: "CREATE", entityType: "Company", entityId: company.id, details: parsed.data });
  return NextResponse.json({ company }, { status: 201 });
}
