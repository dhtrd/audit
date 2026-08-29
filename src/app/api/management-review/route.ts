import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listManagementReviews } from "@/lib/repo";
import { submitManagementReview, isP5Error } from "@/lib/phase5-actions";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId مطلوب" }, { status: 400 });
  return NextResponse.json({ reviews: listManagementReviews(companyId) });
}

const Schema = z.object({
  companyId: z.string().min(1),
  decision: z.enum(["APPROVED", "RETURNED"]),
  notes: z.string().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const r = submitManagementReview({ ...parsed.data, userId: session.sub });
  if (isP5Error(r)) return NextResponse.json({ error: r.error }, { status: r.code });
  return NextResponse.json({ review: r }, { status: 201 });
}
