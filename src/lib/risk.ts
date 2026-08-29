// PRE-AUDIT OS — Phase 3 risk assessment & analytical procedures.
//
// Every number here is COMPUTED from the real imported Trial Balance /
// General Ledger data (Phase 2) — there is no random or placeholder risk
// score. The procedures are standard pre-audit analytical tests:
//   1. TB ↔ GL reconciliation per account
//   2. Large items above materiality
//   3. Round-number entries
//   4. Weekend postings (KSA weekend: Friday/Saturday)
//   5. Duplicate entries
//   6. Reference-sequence gaps (completeness)
//   7. Benford's Law first-digit analysis (Nigrini MAD)
// The overall risk score is a transparent weighted roll-up with a full
// breakdown, exactly like the Phase 1 readiness score — never a black box.

import {
  trialBalanceMovementByAccount, generalLedgerMovementByAccount,
  listGeneralLedgerByCompany, getWriteVersion, type GeneralLedgerRow,
} from "./repo";

export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";

/** Arabic labels for the internal risk-type codes, so the UI never shows raw
 *  identifiers like "WEEKEND_POSTING" to the user. */
export const RISK_TYPE_LABEL: Record<string, string> = {
  TB_GL_MISMATCH: "فرق بين الميزان والأستاذ",
  LARGE_ITEM: "بند كبير فوق الأهمية",
  ROUND_NUMBER: "مبلغ مدوّر",
  WEEKEND_POSTING: "قيد نهاية الأسبوع",
  DUPLICATE: "قيد مكرّر",
  REFERENCE_GAP: "فجوة في ترقيم المراجع",
};

/** Arabic label for a risk-type code (falls back to the code if unknown). */
export function riskTypeLabel(type: string): string {
  return RISK_TYPE_LABEL[type] ?? type;
}

export interface RiskFlag {
  type: string;
  severity: Severity;
  accountCode: string | null;
  title: string;
  detail: string;
  source?: { file: string; row: number } | null;
}

export interface ReconRow {
  account_code: string;
  account_name: string | null;
  tbNet: number;   // TB debit - credit
  glNet: number;   // GL debit - credit
  variance: number;
  hasGl: boolean;
  severity: Severity;
}

export interface BenfordDigit { digit: number; expected: number; observed: number; obsCount: number; }

/** A distinct risk finding key (risk type + account) with its true total
 *  count — complete even when the display `flags` list is capped. Drives
 *  procedure generation and coverage. */
export interface RiskKey {
  riskType: string;
  accountCode: string | null;
  severity: Severity;
  count: number;
}

function sevRank(s: Severity): number {
  return s === "HIGH" ? 0 : s === "MEDIUM" ? 1 : s === "LOW" ? 2 : 3;
}

export interface RiskReport {
  hasData: boolean;
  materiality: number | null;
  counts: { tbAccounts: number; glAccounts: number; glEntries: number };
  overallScore: number;   // 0..100, higher = riskier
  riskLevel: Severity;    // HIGH | MEDIUM | LOW
  scoreBreakdown: { label: string; points: number; detail: string }[];
  procedures: {
    reconciliation: { rows: ReconRow[]; mismatchCount: number; aboveMaterialityCount: number };
    largeItems: { threshold: number | null; count: number };
    roundNumbers: { threshold: number; count: number };
    weekendPostings: { count: number };
    duplicates: { count: number; groupCount: number };
    referenceGaps: { count: number; byJournal: { journal: string; min: number; max: number; missing: number[] }[] };
    benford: { sampleSize: number; digits: BenfordDigit[]; mad: number | null; verdict: string };
  };
  flags: RiskFlag[];
  /** Complete distinct risk keys (uncapped) for procedure generation/coverage. */
  riskKeys: RiskKey[];
  /** True when at least one category produced more findings than the display
   *  cap, so `flags` holds representative samples (the per-category counts in
   *  `procedures` remain the true totals). */
  flagsTruncated: boolean;
  /** The per-category cap applied to `flags`. */
  flagCap: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const amountOf = (e: GeneralLedgerRow) => Math.max(Math.abs(e.debit), Math.abs(e.credit));
const ROUND_THRESHOLD = 1000;
// On a real ledger a single test can match tens of thousands of lines (e.g.
// weekend postings). Emitting a flag object per line makes the report payload
// huge and freezes the browser, while the auditor only needs representative
// examples plus the true totals (kept in `procedures`). Cap the flag objects
// per category; the counts and score are unaffected.
const FLAG_CAP_PER_TYPE = 100;

const DAY_AR = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

// Memoize the whole (fairly heavy) computation. A single dashboard render can
// trigger analyzeRisk several times (readiness + coverage), and each page nav
// recomputes it; keying on the global write-version means the cache is exact —
// invalidated the instant any sensitive write happens — never stale.
const riskCache = new Map<string, { version: number; report: RiskReport }>();

export function analyzeRisk(companyId: string, materiality: number | null): RiskReport {
  const version = getWriteVersion();
  const key = `${companyId}|${materiality ?? "null"}`;
  const hit = riskCache.get(key);
  if (hit && hit.version === version) return hit.report;
  const report = computeRisk(companyId, materiality);
  riskCache.set(key, { version, report });
  return report;
}

function computeRisk(companyId: string, materiality: number | null): RiskReport {
  const tb = trialBalanceMovementByAccount(companyId);
  const glAgg = generalLedgerMovementByAccount(companyId);
  const glRows = listGeneralLedgerByCompany(companyId);

  const flags: RiskFlag[] = [];
  const glByAccount = new Map(glAgg.map((g) => [g.account_code, g]));

  // Distinct risk keys (type + account) with their TRUE totals — this drives
  // procedure generation & coverage, so it must be complete even though the
  // display `flags` list is capped. It is bounded by (#types × #accounts), so
  // it stays tiny regardless of how many lines match.
  const keyAgg = new Map<string, RiskKey>();
  const typeDisplayCount: Record<string, number> = {};
  // Record one finding: always update the complete key aggregate; build the
  // (relatively expensive) flag object only when it is the first example for
  // its key or still within the per-type display cap — so a test matching
  // 40,000 lines builds a few hundred objects, not 40,000.
  function record(type: string, severity: Severity, accountCode: string | null, make: () => RiskFlag): void {
    const dn = (typeDisplayCount[type] = (typeDisplayCount[type] ?? 0) + 1);
    const k = `${type}::${accountCode ?? ""}`;
    let g = keyAgg.get(k);
    const underCap = dn <= FLAG_CAP_PER_TYPE;
    let flag: RiskFlag | null = null;
    if (!g || underCap) flag = make();
    if (!g) { g = { riskType: type, accountCode, severity, count: 0 }; keyAgg.set(k, g); }
    g.count++;
    if (sevRank(severity) < sevRank(g.severity)) g.severity = severity;
    if (underCap && flag) flags.push(flag);
  }

  // ---- 1. TB ↔ GL reconciliation per account ----
  const reconRows: ReconRow[] = [];
  let mismatchCount = 0;
  let aboveMaterialityCount = 0;
  for (const a of tb) {
    const gl = glByAccount.get(a.account_code);
    const tbNet = round2(a.debit - a.credit);
    const glNet = gl ? round2(gl.debit - gl.credit) : 0;
    const hasGl = !!gl;
    const variance = round2(tbNet - glNet);
    let severity: Severity = "INFO";
    if (hasGl && Math.abs(variance) > 0.005) {
      mismatchCount++;
      const aboveMat = materiality != null && Math.abs(variance) >= materiality;
      if (aboveMat) aboveMaterialityCount++;
      severity = aboveMat ? "HIGH" : "MEDIUM";
      const sev = severity;
      record("TB_GL_MISMATCH", sev, a.account_code, () => ({
        type: "TB_GL_MISMATCH", severity: sev, accountCode: a.account_code,
        title: `فرق بين الميزان والأستاذ العام — حساب ${a.account_code}`,
        detail: `صافي الميزان ${fmt(tbNet)} مقابل صافي الأستاذ ${fmt(glNet)} (فرق ${fmt(variance)})`,
        source: null,
      }));
    } else if (!hasGl) {
      severity = "INFO";
    }
    reconRows.push({ account_code: a.account_code, account_name: a.account_name, tbNet, glNet, variance, hasGl, severity });
  }

  // ---- 2. Large items above materiality ----
  let largeCount = 0;
  if (materiality != null) {
    for (const e of glRows) {
      if (amountOf(e) >= materiality) {
        largeCount++;
        record("LARGE_ITEM", "HIGH", e.account_code, () => ({
          type: "LARGE_ITEM", severity: "HIGH", accountCode: e.account_code,
          title: `بند كبير فوق الأهمية النسبية — حساب ${e.account_code}`,
          detail: `${e.entry_date ?? ""} ${e.reference ?? ""} مبلغ ${fmt(amountOf(e))} ≥ الأهمية ${fmt(materiality)}`.trim(),
          source: { file: e.source_file, row: e.source_row },
        }));
      }
    }
  }

  // ---- 3. Round-number entries ----
  let roundCount = 0;
  for (const e of glRows) {
    const amt = amountOf(e);
    if (amt >= ROUND_THRESHOLD && amt % ROUND_THRESHOLD === 0) {
      roundCount++;
      record("ROUND_NUMBER", "LOW", e.account_code, () => ({
        type: "ROUND_NUMBER", severity: "LOW", accountCode: e.account_code,
        title: `مبلغ مدوّر — حساب ${e.account_code}`,
        detail: `${e.entry_date ?? ""} مبلغ ${fmt(amt)} (مضاعف تام لـ ${ROUND_THRESHOLD}) — قد يشير إلى تقدير/قيد يدوي`.trim(),
        source: { file: e.source_file, row: e.source_row },
      }));
    }
  }

  // ---- 4. Weekend postings (KSA weekend = Friday(5) / Saturday(6)) ----
  let weekendCount = 0;
  for (const e of glRows) {
    if (!e.entry_date) continue;
    const d = new Date(e.entry_date + "T00:00:00Z");
    if (isNaN(d.getTime())) continue;
    const dow = d.getUTCDay();
    if (dow === 5 || dow === 6) {
      weekendCount++;
      record("WEEKEND_POSTING", "MEDIUM", e.account_code, () => ({
        type: "WEEKEND_POSTING", severity: "MEDIUM", accountCode: e.account_code,
        title: `قيد بتاريخ نهاية الأسبوع — حساب ${e.account_code}`,
        detail: `${e.entry_date} (${DAY_AR[dow]}) ${e.reference ?? ""} مبلغ ${fmt(amountOf(e))}`.trim(),
        source: { file: e.source_file, row: e.source_row },
      }));
    }
  }

  // ---- 5. Duplicate entries (same date + account + debit + credit) ----
  const dupMap = new Map<string, GeneralLedgerRow[]>();
  for (const e of glRows) {
    if (amountOf(e) === 0) continue;
    const key = [e.entry_date, e.account_code, e.debit, e.credit].join("|");
    (dupMap.get(key) ?? dupMap.set(key, []).get(key)!).push(e);
  }
  let dupCount = 0, dupGroups = 0;
  for (const [, group] of dupMap) {
    if (group.length > 1) {
      dupGroups++;
      dupCount += group.length;
      const e = group[0];
      record("DUPLICATE", "MEDIUM", e.account_code, () => ({
        type: "DUPLICATE", severity: "MEDIUM", accountCode: e.account_code,
        title: `قيود مكرّرة (${group.length}) — حساب ${e.account_code}`,
        detail: `${e.entry_date ?? ""} مبلغ مدين ${fmt(e.debit)} / دائن ${fmt(e.credit)} يتكرر ${group.length} مرات (صفوف: ${group.map((g) => g.source_row).join("، ")})`.trim(),
        source: { file: e.source_file, row: e.source_row },
      }));
    }
  }

  // ---- 6. Reference-sequence gaps per journal (completeness) ----
  const seqByJournal = new Map<string, Set<number>>();
  for (const e of glRows) {
    const j = e.journal ?? "—";
    const m = (e.reference ?? "").match(/(\d+)\s*$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    (seqByJournal.get(j) ?? seqByJournal.set(j, new Set()).get(j)!).add(n);
  }
  const gapJournals: { journal: string; min: number; max: number; missing: number[] }[] = [];
  let gapCount = 0;
  for (const [journal, set] of seqByJournal) {
    if (set.size < 3) continue; // need a real sequence
    const nums = Array.from(set).sort((a, b) => a - b);
    const min = nums[0], max = nums[nums.length - 1];
    const missing: number[] = [];
    for (let i = min; i <= max; i++) if (!set.has(i)) missing.push(i);
    if (missing.length > 0 && missing.length <= (max - min)) {
      gapCount += missing.length;
      gapJournals.push({ journal, min, max, missing: missing.slice(0, 50) });
      record("REFERENCE_GAP", "LOW", null, () => ({
        type: "REFERENCE_GAP", severity: "LOW", accountCode: null,
        title: `فجوات في تسلسل المراجع — يومية ${journal}`,
        detail: `المدى ${min}–${max}، مفقود ${missing.length} رقمًا: ${missing.slice(0, 20).join("، ")}${missing.length > 20 ? " …" : ""}`,
        source: null,
      }));
    }
  }

  // ---- 7. Benford's Law (first significant digit) ----
  const firstDigits: number[] = [];
  for (const e of glRows) {
    const amt = amountOf(e);
    if (amt <= 0) continue;
    const s = String(amt).replace(/[^0-9]/g, "").replace(/^0+/, "");
    if (s.length === 0) continue;
    const d = parseInt(s[0], 10);
    if (d >= 1 && d <= 9) firstDigits.push(d);
  }
  const sampleSize = firstDigits.length;
  const digits: BenfordDigit[] = [];
  let mad: number | null = null;
  let verdict = "عينة غير كافية لتحليل بنفورد (يُنصح بـ 50+ قيدًا)";
  if (sampleSize > 0) {
    const obsCounts = new Array(10).fill(0);
    for (const d of firstDigits) obsCounts[d]++;
    let devSum = 0;
    for (let d = 1; d <= 9; d++) {
      const expected = Math.log10(1 + 1 / d);
      const observed = obsCounts[d] / sampleSize;
      digits.push({ digit: d, expected: round4(expected), observed: round4(observed), obsCount: obsCounts[d] });
      devSum += Math.abs(observed - expected);
    }
    mad = round4(devSum / 9);
    if (sampleSize < 50) verdict = `عينة صغيرة (${sampleSize} قيدًا) — النتيجة إرشادية فقط`;
    else if (mad < 0.006) verdict = "مطابقة وثيقة لقانون بنفورد";
    else if (mad < 0.012) verdict = "مطابقة مقبولة";
    else if (mad < 0.015) verdict = "مطابقة حدّية — يُنصح بالفحص";
    else verdict = "عدم مطابقة — مؤشر مخاطر يستدعي فحصًا تفصيليًا";
  }
  const benfordNonconforming = mad != null && sampleSize >= 50 && mad >= 0.015;
  const benfordMarginal = mad != null && sampleSize >= 50 && mad >= 0.012 && mad < 0.015;

  // ---- Overall risk score (transparent weighted roll-up) ----
  const tbTotalDebit = round2(tb.reduce((s, a) => s + a.debit, 0));
  const tbTotalCredit = round2(tb.reduce((s, a) => s + a.credit, 0));
  const tbUnbalanced = tb.length > 0 && Math.abs(tbTotalDebit - tbTotalCredit) > 0.005;

  const breakdown: { label: string; points: number; detail: string }[] = [];
  const add = (label: string, points: number, detail: string) => { if (points > 0) breakdown.push({ label, points, detail }); };

  add("عدم توازن الميزان (مدين ≠ دائن)", tbUnbalanced ? 25 : 0,
    tbUnbalanced ? `مدين ${fmt(tbTotalDebit)} ≠ دائن ${fmt(tbTotalCredit)}` : "");
  add("فروقات الميزان/الأستاذ فوق الأهمية النسبية", Math.min(aboveMaterialityCount * 10, 25), `${aboveMaterialityCount} حساب`);
  add("فروقات الميزان/الأستاذ (إجمالًا)", Math.min((mismatchCount - aboveMaterialityCount) * 5, 15), `${mismatchCount - aboveMaterialityCount} حساب`);
  add("بنود كبيرة فوق الأهمية النسبية", Math.min(largeCount * 3, 15), `${largeCount} قيد`);
  add("قيود مكرّرة", Math.min(dupGroups * 5, 15), `${dupGroups} مجموعة`);
  add("قيود بنهاية الأسبوع", Math.min(weekendCount * 2, 10), `${weekendCount} قيد`);
  add("فجوات في ترقيم المراجع", Math.min(gapCount * 2, 10), `${gapCount} رقم مفقود`);
  add("مبالغ مدوّرة", Math.min(roundCount, 5), `${roundCount} قيد`);
  add("عدم مطابقة قانون بنفورد", benfordNonconforming ? 15 : (benfordMarginal ? 8 : 0),
    mad != null ? `MAD = ${mad}` : "");

  let overallScore = Math.min(100, breakdown.reduce((s, b) => s + b.points, 0));
  overallScore = Math.round(overallScore);
  const riskLevel: Severity = overallScore >= 60 ? "HIGH" : overallScore >= 30 ? "MEDIUM" : "LOW";

  // Sort flags by severity for the register
  const order: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    hasData: tb.length > 0 || glRows.length > 0,
    materiality,
    counts: { tbAccounts: tb.length, glAccounts: glAgg.length, glEntries: glRows.length },
    overallScore, riskLevel, scoreBreakdown: breakdown,
    procedures: {
      reconciliation: { rows: reconRows, mismatchCount, aboveMaterialityCount },
      largeItems: { threshold: materiality, count: largeCount },
      roundNumbers: { threshold: ROUND_THRESHOLD, count: roundCount },
      weekendPostings: { count: weekendCount },
      duplicates: { count: dupCount, groupCount: dupGroups },
      referenceGaps: { count: gapCount, byJournal: gapJournals },
      benford: { sampleSize, digits, mad, verdict },
    },
    flags,
    riskKeys: Array.from(keyAgg.values()),
    flagsTruncated:
      largeCount > FLAG_CAP_PER_TYPE || roundCount > FLAG_CAP_PER_TYPE ||
      weekendCount > FLAG_CAP_PER_TYPE || dupGroups > FLAG_CAP_PER_TYPE,
    flagCap: FLAG_CAP_PER_TYPE,
  };
}

function fmt(n: number): string { return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
