import { NextRequest, NextResponse } from "next/server";
import { attemptLogin } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.email || !body?.password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }
  const result = await attemptLogin(body.email, body.password);
  if (!result.ok) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  return NextResponse.json({ user: result.session });
}
