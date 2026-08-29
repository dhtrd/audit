import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listEvidence } from "@/lib/repo";
import { readEvidenceBytes } from "@/lib/procedure-actions";

export const runtime = "nodejs";

// GET /api/procedures/[id]/evidence/[eid] — download an evidence file (any session)
export async function GET(_req: NextRequest, { params }: { params: { id: string; eid: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ev = listEvidence(params.id).find((e) => e.id === params.eid);
  if (!ev) return NextResponse.json({ error: "not found" }, { status: 404 });
  const bytes = readEvidenceBytes(ev.stored_path);
  if (!bytes) return NextResponse.json({ error: "الملف غير متوفر على الخادم" }, { status: 410 });
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(ev.file_name)}`,
    },
  });
}
