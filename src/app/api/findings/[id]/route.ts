import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { getFinding } from "@/lib/repo";
import { updateFindingAction, isP5Error } from "@/lib/phase5-actions";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const f = getFinding(params.id);
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ finding: f });
}

const PatchSchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "ACCEPTED_RISK"]).optional(),
  managementResponse: z.string().nullable().optional(),
  recommendation: z.string().nullable().optional(),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = updateFindingAction({ findingId: params.id, ...parsed.data, userId: session.sub });
  if (isP5Error(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ finding: r });
}
