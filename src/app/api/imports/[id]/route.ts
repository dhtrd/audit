import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getImportBatch } from "@/lib/repo";
import { parseFile } from "@/lib/excel";

export const runtime = "nodejs";

// GET /api/imports/[id]  — batch detail + a small parsed preview
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const batch = getImportBatch(params.id);
  if (!batch) return NextResponse.json({ error: "not found" }, { status: 404 });

  let preview: { headers: string[]; rows: Record<string, unknown>[] } | null = null;
  try {
    const parsed = await parseFile(batch.stored_path, batch.file_name);
    preview = { headers: parsed.headers, rows: parsed.rows.slice(0, 10).map((r) => r.cells) };
  } catch {
    preview = null;
  }
  return NextResponse.json({ batch, preview });
}
