import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { addEvidenceFile, isProcError } from "@/lib/procedure-actions";

export const runtime = "nodejs";

// POST /api/procedures/[id]/evidence — upload an evidence file (multipart, ADMIN)
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  const file = form.get("file");
  const note = form.get("note") ? String(form.get("note")) : null;
  if (!(file instanceof File)) return NextResponse.json({ error: "الملف مطلوب" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = addEvidenceFile({ procedureId: params.id, fileName: file.name, buffer, note, userId: session.sub });
  if (isProcError(result)) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ evidence: result }, { status: 201 });
}
