import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { signReport, reportSignatureStatus, isSignError } from "@/lib/report-signature";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/reports/[companyId]/sign — current signature/integrity status
export async function GET(_req: NextRequest, { params }: { params: { companyId: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ status: reportSignatureStatus(params.companyId) });
}

const Schema = z.object({ note: z.string().nullable().optional() });

// POST /api/reports/[companyId]/sign — sign the current report content (ADMIN)
export async function POST(req: NextRequest, { params }: { params: { companyId: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const parsed = Schema.safeParse(body ?? {});
  const note = parsed.success ? parsed.data.note ?? null : null;
  const r = signReport({ companyId: params.companyId, note, userId: session.sub });
  if (isSignError(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ hash: r.hash }, { status: 201 });
}
