// PRE-AUDIT OS — Phase 2 uploaded-file storage.
//
// The uploaded file is kept on disk (this is the local stand-in for the
// S3-compatible storage the README noted arrives in Phase 2). Each upload
// gets its own directory so the original bytes are preserved for lineage /
// re-parsing at commit time. Nothing is ever parsed straight from memory
// and thrown away.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.join(process.cwd(), "data", "uploads");

export const ALLOWED_EXT = [".xlsx", ".xlsm", ".xls", ".csv"];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export function isAllowedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXT.some((e) => lower.endsWith(e));
}

/**
 * Repair an Arabic file name that arrived mojibake-encoded — i.e. its UTF-8
 * bytes were decoded as Latin-1 during the multipart upload (so "دفتر" shows
 * up as "Ø¯ÙØªØ±"). If the name already contains Arabic it is returned as-is;
 * otherwise we try re-decoding latin1→utf8 and keep it only if that yields
 * Arabic. Safe for plain ASCII names (returned unchanged).
 */
export function repairFileName(name: string): string {
  if (!name) return name;
  const ARABIC = /[؀-ۿ]/;
  if (ARABIC.test(name)) return name; // already correct
  try {
    const repaired = Buffer.from(name, "latin1").toString("utf8");
    if (ARABIC.test(repaired)) return repaired;
  } catch {
    /* fall through */
  }
  return name;
}

function safeName(name: string): string {
  // keep the extension and unicode (Arabic) letters; strip path separators
  // and collapse whitespace so the stored filename is filesystem-safe.
  const base = name.replace(/[/\\]/g, "_").replace(/\s+/g, "_").trim();
  return base || "upload";
}

export function saveUploadedFile(originalName: string, data: Buffer): { storedPath: string; dir: string } {
  const dir = path.join(UPLOAD_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const storedPath = path.join(dir, safeName(originalName));
  fs.writeFileSync(storedPath, data);
  return { storedPath, dir };
}
