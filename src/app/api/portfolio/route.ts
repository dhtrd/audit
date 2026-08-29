import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computePortfolio } from "@/lib/portfolio";

export const runtime = "nodejs";

// GET /api/portfolio — firm-level overview across all companies
export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(computePortfolio());
}
