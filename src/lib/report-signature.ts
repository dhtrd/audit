// PRE-AUDIT OS — Phase 12 report integrity signature.
//
// Computes a SHA-256 over a canonical serialization of the report's real
// content (readiness, risk, adjusted TB, findings, adjustments, review).
// Signing records that hash + who + when. On later views the current hash
// is recomputed and compared, so any change to the underlying data after
// sign-off is detected (tamper / drift detection) — a real integrity
// control, not decoration.

import crypto from "node:crypto";
import { gatherReportData } from "./audit-pack";
import { createReportSignature, latestReportSignature, getCompany, writeAuditLog } from "./repo";

export type SignError = { error: string; code: number };
function err(error: string, code: number): SignError { return { error, code }; }
export function isSignError(x: unknown): x is SignError { return !!x && typeof x === "object" && "error" in (x as any); }

/** Deterministic hash of the report's substantive content (excludes the
 *  render timestamp, which changes on every view). */
export function computeReportHash(companyId: string): string {
  const d = gatherReportData(companyId, "");
  const canonical = {
    company: { id: d.company?.id, legal_name: d.company?.legal_name, cr: d.company?.commercial_registration, vat: d.company?.vat_number },
    materiality: d.materiality,
    readiness: { score: d.readiness.score, dims: d.readiness.dimensions.map((x) => [x.key, x.earned]) },
    risk: { score: d.risk.overallScore, flags: d.risk.flags.map((f) => [f.type, f.accountCode, f.detail]) },
    adjustedTB: d.adjustedTB.map((r) => [r.account_code, r.tb_debit, r.tb_credit, r.adj_debit, r.adj_credit]),
    procedures: d.procedures.map((p) => [p.id, p.status, p.conclusion, p.evidence_count]),
    findings: d.findings.map((f) => [f.id, f.severity, f.status, f.title, f.management_response]),
    adjustments: d.adjustments.map((a) => [a.id, a.status, a.description, a.lines.map((l) => [l.account_code, l.debit, l.credit])]),
    reviews: d.reviews.map((r) => [r.id, r.decision, r.created_at]),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function signReport(input: { companyId: string; note?: string | null; userId: string | null }): { hash: string } | SignError {
  if (!getCompany(input.companyId)) return err("الشركة غير موجودة", 404);
  const hash = computeReportHash(input.companyId);
  createReportSignature({ companyId: input.companyId, contentHash: hash, note: input.note ?? null, signedBy: input.userId });
  writeAuditLog({ userId: input.userId, action: "REPORT_SIGN", entityType: "Company", entityId: input.companyId, details: { hash: hash.slice(0, 16) } });
  return { hash };
}

export interface SignatureStatus {
  signed: boolean;
  signerName: string | null;
  signedAt: string | null;
  signedHash: string | null;
  currentHash: string;
  matches: boolean; // current content still matches the signed hash
  note: string | null;
}

/** Current integrity status: is there a signature, and does the content still match it? */
export function reportSignatureStatus(companyId: string): SignatureStatus {
  const current = computeReportHash(companyId);
  const sig = latestReportSignature(companyId);
  return {
    signed: !!sig,
    signerName: sig?.signer_name ?? null,
    signedAt: sig?.signed_at ?? null,
    signedHash: sig?.content_hash ?? null,
    currentHash: current,
    matches: !!sig && sig.content_hash === current,
    note: sig?.note ?? null,
  };
}
