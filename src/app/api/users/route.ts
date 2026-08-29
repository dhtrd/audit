import { NextRequest, NextResponse } from "next/server";
import { getSession, hashPassword } from "@/lib/auth";
import { createUser, findUserByEmail, listUsers, writeAuditLog } from "@/lib/repo";
import { z } from "zod";

export const runtime = "nodejs";

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "AUDITOR", "EXECUTOR"]).default("AUDITOR"),
});

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ users: listUsers() });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateUserSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  if (findUserByEmail(parsed.data.email)) {
    return NextResponse.json({ error: "email already exists" }, { status: 409 });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const user = createUser({ name: parsed.data.name, email: parsed.data.email, passwordHash, role: parsed.data.role });
  writeAuditLog({ userId: session.sub, action: "CREATE", entityType: "User", entityId: user.id, details: { email: user.email, role: user.role } });

  const { password_hash, ...safeUser } = user;
  return NextResponse.json({ user: safeUser }, { status: 201 });
}
