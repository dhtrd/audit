import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAdjustment, listAdjustmentLines } from "@/lib/repo";
import { decideAdjustment, isP5Error } from "@/lib/phase5-actions";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const a = getAdjustment(params.id);
  if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ adjustment: a, lines: listAdjustmentLines(params.id) });
}

const PatchSchema = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) });

// PATCH /api/adjustments/[id] — approve/reject (ADMIN); approval re-verifies balance
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = decideAdjustment({ adjustmentId: params.id, decision: parsed.data.decision, userId: session.sub });
  if (isP5Error(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ adjustment: r });
}
