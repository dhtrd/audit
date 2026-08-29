// Next.js server-startup hook. Runs once when the server process boots (not
// during build, not on the edge). We use it to auto-create the first ADMIN so
// a hosted deployment (Railway/Render/Docker) has a working login immediately
// without anyone needing shell access to run `npm run db:seed`.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureSeedAdmin } = await import("./lib/seed");
      const r = await ensureSeedAdmin();
      if (r.created) console.log(`[startup] seeded first admin: ${r.email}`);
    } catch (e) {
      console.error("[startup] admin seed skipped:", (e as Error)?.message);
    }
  }
}
