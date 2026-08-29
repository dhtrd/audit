import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { saveMapping, isImportError } from "@/lib/import-actions";
import { z } from "zod";

export const runtime = "nodejs";

const MappingSchema = z.object({
  confirmedType: z.enum(["TRIAL_BALANCE", "GENERAL_LEDGER"]),
  mapping: z.record(z.string()),
});

// PATCH /api/imports/[id]/mapping — save confirmed type + column mapping
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = MappingSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const result = saveMapping({
    batchId: params.id,
    confirmedType: parsed.data.confirmedType,
    mapping: parsed.data.mapping,
    userId: session.sub,
  });
  if (isImportError(result)) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ batch: result });
}
