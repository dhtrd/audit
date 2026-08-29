// PRE-AUDIT OS — Phase 7 portfolio (firm-level) overview.
//
// A cross-company summary for a manager overseeing several engagements.
// Every figure reuses the real per-company engines (readiness, risk,
// findings, procedures) — no separate/duplicated logic, no placeholders.

import {
  listCompanies, findingStatusCounts, procedureStatusCounts,
  latestManagementReview, lastImportAt, getMateriality, getWriteVersion,
} from "./repo";
import { computeFullReadiness } from "./readiness2";
import { analyzeRisk } from "./risk";
import { computeCoverage } from "./procedures";

export interface PortfolioRow {
  companyId: string;
  name: string;
  hasData: boolean;
  readinessScore: number;
  readinessLevel: "HIGH" | "MEDIUM" | "LOW";
  riskScore: number;
  riskLevel: "HIGH" | "MEDIUM" | "LOW" | "INFO";
  highRiskFlags: number;
  openFindings: number;
  totalFindings: number;
  proceduresOpen: number;
  proceduresDone: number;
  coveragePct: number;
  lastReview: "APPROVED" | "RETURNED" | null;
  lastImportAt: string | null;
}

export interface Portfolio {
  rows: PortfolioRow[];
  totals: {
    companies: number;
    withData: number;
    avgReadiness: number;      // over companies that have data
    ready: number;             // readiness level HIGH
    notReady: number;          // has data but level LOW
    totalOpenFindings: number;
    totalHighRiskFlags: number;
  };
}

// In-process memoization keyed by the global write version. The portfolio
// aggregates every company's readiness/risk (many SQL queries); this caches
// the result and recomputes only after a write actually changes something —
// correct invalidation, never stale.
let cache: { version: number; result: Portfolio } | null = null;

export function computePortfolio(): Portfolio {
  const version = getWriteVersion();
  if (cache && cache.version === version) return cache.result;
  const result = computePortfolioUncached();
  cache = { version, result };
  return result;
}

function computePortfolioUncached(): Portfolio {
  const companies = listCompanies();
  const rows: PortfolioRow[] = companies.map((c) => {
    const readiness = computeFullReadiness(c.id);
    const mat = getMateriality(c.id, null);
    const risk = analyzeRisk(c.id, mat?.amount ?? null);
    const fc = findingStatusCounts(c.id);
    const pc = procedureStatusCounts(c.id);
    const cov = computeCoverage(c.id);
    const review = latestManagementReview(c.id);
    // Use the complete risk keys (uncapped), not the display flags which are
    // capped per type — otherwise a high-volume ledger would undercount here.
    const highRiskFlags = risk.riskKeys.filter((k) => k.severity === "HIGH").length;
    return {
      companyId: c.id,
      name: c.legal_name,
      hasData: readiness.hasData,
      readinessScore: readiness.score,
      readinessLevel: readiness.level,
      riskScore: risk.overallScore,
      riskLevel: risk.riskLevel,
      highRiskFlags,
      openFindings: fc.OPEN,
      totalFindings: fc.OPEN + fc.RESOLVED + fc.ACCEPTED_RISK,
      proceduresOpen: pc.OPEN + pc.IN_PROGRESS,
      proceduresDone: pc.DONE,
      coveragePct: cov.pct,
      lastReview: review?.decision ?? null,
      lastImportAt: lastImportAt(c.id),
    };
  });

  // Sort: companies needing the most attention first (has data & lowest readiness),
  // then companies with no data, then the rest.
  rows.sort((a, b) => {
    if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
    return a.readinessScore - b.readinessScore;
  });

  const withData = rows.filter((r) => r.hasData);
  const avgReadiness = withData.length === 0 ? 0
    : Math.round(withData.reduce((s, r) => s + r.readinessScore, 0) / withData.length);

  return {
    rows,
    totals: {
      companies: rows.length,
      withData: withData.length,
      avgReadiness,
      ready: rows.filter((r) => r.readinessLevel === "HIGH" && r.hasData).length,
      notReady: rows.filter((r) => r.readinessLevel === "LOW" && r.hasData).length,
      totalOpenFindings: rows.reduce((s, r) => s + r.openFindings, 0),
      totalHighRiskFlags: rows.reduce((s, r) => s + r.highRiskFlags, 0),
    },
  };
}
