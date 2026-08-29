import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { runCommit, isImportError } from "@/lib/import-actions";

export const runtime = "nodejs";

// POST /api/imports/[id]/commit — validate + reconcile + import (or BLOCK)
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const result = await runCommit({ batchId: params.id, userId: session.sub });
  if (isImportError(result)) return NextResponse.json({ error: result.error }, { status: result.code });

  // A blocked reconciliation is a real, expected outcome — surface it with
  // 409 Conflict so callers can distinguish it from a successful import.
  const status = result.status === "BLOCKED" ? 409 : 200;
  return NextResponse.json({ report: result }, { status });
}
