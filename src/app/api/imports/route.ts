import { NextRequest, NextResponse } from "next/server";
import { getSession, canExecute } from "@/lib/auth";
import { listImportBatches } from "@/lib/repo";
import { uploadAndDetect, isImportError } from "@/lib/import-actions";

export const runtime = "nodejs";

// GET /api/imports  — list import batches (optionally by company)
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const companyId = req.nextUrl.searchParams.get("companyId") ?? undefined;
  return NextResponse.json({ batches: listImportBatches(companyId) });
}

// POST /api/imports  — upload an Excel/CSV file (multipart/form-data) and auto-detect its type
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!canExecute(session.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });

  const file = form.get("file");
  const companyId = String(form.get("companyId") || "");
  const fiscalYearId = form.get("fiscalYearId") ? String(form.get("fiscalYearId")) : null;
  if (!(file instanceof File)) return NextResponse.json({ error: "الملف مطلوب" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await uploadAndDetect({
    companyId, fiscalYearId, fileName: file.name, buffer, userId: session.sub,
  });
  if (isImportError(result)) return NextResponse.json({ error: result.error }, { status: result.code });
  return NextResponse.json({ batch: result }, { status: 201 });
}
