import { listCompanies, listFiscalYears } from "./repo";

// IMPORTANT — honesty note:
// Section 8 of the spec defines a full "Audit Readiness Score" weighted
// across data quality, reconciliation, risk, procedures, evidence,
// findings, adjustments, and management review. None of those exist
// yet — they are Phase 2–6. Computing that formula now with zero data
// would produce a meaningless number dressed up as a real one, which
// is exactly the "fake dashboard" the spec explicitly forbids.
//
// What this DOES compute for real, from the real database, is a
// narrower "Foundation Setup Readiness" — whether the basic setup
// Phase 1 is responsible for is actually in place. It is clearly
// labeled as such in the UI.

export interface FoundationReadiness {
  score: number; // 0-100
  breakdown: { label: string; points: number; achieved: boolean }[];
  companiesCount: number;
  fiscalYearsCount: number;
}

export function computeFoundationReadiness(): FoundationReadiness {
  const companies = listCompanies();
  const fiscalYears = listFiscalYears();

  const hasCompany = companies.length > 0;
  const primaryCompany = companies[0];
  const companyProfileComplete =
    hasCompany &&
    !!primaryCompany.commercial_registration &&
    !!primaryCompany.vat_number;

  const hasFiscalYear = fiscalYears.length > 0;
  const hasActiveFiscalYear = fiscalYears.some((fy) => fy.status !== "CLOSED");

  const breakdown = [
    { label: "تسجيل بيانات الشركة الأساسية", points: 35, achieved: hasCompany },
    { label: "اكتمال ملف الشركة (سجل تجاري + رقم ضريبي)", points: 25, achieved: companyProfileComplete },
    { label: "إنشاء سنة مالية واحدة على الأقل", points: 25, achieved: hasFiscalYear },
    { label: "وجود سنة مالية قيد العمل (غير مقفلة)", points: 15, achieved: hasActiveFiscalYear },
  ];

  const score = breakdown.reduce((sum, b) => sum + (b.achieved ? b.points : 0), 0);

  return {
    score,
    breakdown,
    companiesCount: companies.length,
    fiscalYearsCount: fiscalYears.length,
  };
}
