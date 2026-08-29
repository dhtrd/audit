import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { getProcedure, listEvidence } from "@/lib/repo";
import { updateProcedureAction, isProcError } from "@/lib/procedure-actions";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/procedures/[id] — procedure detail + evidence
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const proc = getProcedure(params.id);
  if (!proc) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ procedure: proc, evidence: listEvidence(params.id) });
}

const PatchSchema = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "DONE", "NA"]).optional(),
  conclusion: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
});

// PATCH /api/procedures/[id] — update status/conclusion/assignee (ADMIN)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = updateProcedureAction({ procedureId: params.id, ...parsed.data, userId: session.sub });
  if (isProcError(result)) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ procedure: result });
}
