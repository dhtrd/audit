import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { createMappingTemplate, listMappingTemplates, writeAuditLog } from "@/lib/repo";
import { z } from "zod";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().min(1),
  fileType: z.enum(["TRIAL_BALANCE", "GENERAL_LEDGER"]),
  mapping: z.record(z.string()),
});

// GET /api/mapping-templates?fileType=TRIAL_BALANCE
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const fileType = req.nextUrl.searchParams.get("fileType") as any;
  return NextResponse.json({ templates: listMappingTemplates(fileType ?? undefined) });
}

// POST /api/mapping-templates — save a reusable column mapping
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  try {
    const tpl = createMappingTemplate({
      name: parsed.data.name, fileType: parsed.data.fileType, mapping: parsed.data.mapping, createdBy: session.sub,
    });
    writeAuditLog({ userId: session.sub, action: "CREATE", entityType: "MappingTemplate", entityId: tpl.id, details: { name: tpl.name, fileType: tpl.file_type } });
    return NextResponse.json({ template: tpl }, { status: 201 });
  } catch (e: any) {
    if (e?.code === "ERR_SQLITE_ERROR" && e?.errcode === 2067) {
      return NextResponse.json({ error: `يوجد قالب بنفس الاسم لهذا النوع بالفعل` }, { status: 409 });
    }
    throw e;
  }
}
