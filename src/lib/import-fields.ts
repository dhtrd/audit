// PRE-AUDIT OS — Phase 2 standard fields, aliases, and value parsing.
//
// The "standard fields" are the canonical columns the rest of the system
// stores. A user's file columns are mapped onto these. Aliases (English +
// Arabic + common Odoo export labels) power (a) auto-detection of file
// type and (b) an auto-suggested mapping the user can correct.

import type { ImportFileType } from "./repo";

export interface StandardField {
  key: string;
  label: string;        // Arabic UI label
  aliases: string[];    // header spellings we recognise
  types: ImportFileType[];
  required: ImportFileType[]; // file types where this field must be mapped
  kind: "text" | "number" | "date";
}

export const STANDARD_FIELDS: Record<string, StandardField> = {
  account_code: {
    key: "account_code", label: "رمز الحساب", kind: "text",
    aliases: ["account code", "account", "acct", "acct code", "gl account", "code", "account no", "account number",
      "رمز الحساب", "رقم الحساب", "الحساب", "كود الحساب", "حساب", "رمز"],
    types: ["TRIAL_BALANCE", "GENERAL_LEDGER"], required: ["TRIAL_BALANCE", "GENERAL_LEDGER"],
  },
  account_name: {
    key: "account_name", label: "اسم الحساب", kind: "text",
    aliases: ["account name", "name", "account label", "label", "description of account",
      "اسم الحساب", "الاسم", "بيان الحساب", "مسمى الحساب"],
    types: ["TRIAL_BALANCE", "GENERAL_LEDGER"], required: [],
  },
  opening_balance: {
    key: "opening_balance", label: "الرصيد الافتتاحي", kind: "number",
    aliases: ["opening balance", "opening", "beginning balance", "initial balance", "opening bal",
      "رصيد افتتاحي", "الرصيد الافتتاحي", "رصيد اول المدة", "رصيد أول المدة"],
    types: ["TRIAL_BALANCE"], required: [],
  },
  debit: {
    key: "debit", label: "مدين", kind: "number",
    aliases: ["debit", "dr", "debits", "debit amount", "مدين", "المدين", "مبلغ مدين"],
    types: ["TRIAL_BALANCE", "GENERAL_LEDGER"], required: ["TRIAL_BALANCE", "GENERAL_LEDGER"],
  },
  credit: {
    key: "credit", label: "دائن", kind: "number",
    aliases: ["credit", "cr", "credits", "credit amount", "دائن", "الدائن", "مبلغ دائن"],
    types: ["TRIAL_BALANCE", "GENERAL_LEDGER"], required: ["TRIAL_BALANCE", "GENERAL_LEDGER"],
  },
  closing_balance: {
    key: "closing_balance", label: "الرصيد الختامي", kind: "number",
    aliases: ["closing balance", "closing", "ending balance", "balance", "final balance", "net balance", "closing bal",
      "رصيد ختامي", "الرصيد الختامي", "الرصيد", "رصيد", "رصيد اخر المدة", "رصيد آخر المدة", "الصافي"],
    types: ["TRIAL_BALANCE"], required: [],
  },
  entry_date: {
    key: "entry_date", label: "التاريخ", kind: "date",
    aliases: ["date", "entry date", "posting date", "transaction date", "document date",
      "تاريخ", "التاريخ", "تاريخ القيد", "تاريخ العملية"],
    types: ["GENERAL_LEDGER"], required: [],
  },
  journal: {
    key: "journal", label: "اليومية", kind: "text",
    aliases: ["journal", "journal entry", "move", "journal name", "daybook", "je",
      "يومية", "اليومية", "دفتر اليومية", "القيد", "رقم القيد"],
    types: ["GENERAL_LEDGER"], required: [],
  },
  partner: {
    key: "partner", label: "الطرف / الشريك", kind: "text",
    aliases: ["partner", "customer", "vendor", "supplier", "contact", "third party",
      "شريك", "الشريك", "العميل", "المورد", "الطرف", "جهة"],
    types: ["GENERAL_LEDGER"], required: [],
  },
  reference: {
    key: "reference", label: "المرجع", kind: "text",
    aliases: ["reference", "ref", "voucher", "voucher no", "document", "doc", "move name", "number",
      "مرجع", "المرجع", "سند", "رقم السند", "رقم المستند", "المستند"],
    types: ["GENERAL_LEDGER"], required: [],
  },
  description: {
    key: "description", label: "البيان", kind: "text",
    aliases: ["description", "label", "narration", "memo", "details", "particulars", "line label", "communication",
      "بيان", "البيان", "الوصف", "التفاصيل", "الشرح", "ملاحظات", "التواصل", "تواصل"],
    types: ["GENERAL_LEDGER"], required: [],
  },
};

export function fieldsForType(type: ImportFileType): StandardField[] {
  return Object.values(STANDARD_FIELDS).filter((f) => f.types.includes(type));
}

export function requiredFieldsForType(type: ImportFileType): StandardField[] {
  return Object.values(STANDARD_FIELDS).filter((f) => f.required.includes(type));
}

// ---------------- Value parsing ----------------

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

function normalizeDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const ai = ARABIC_INDIC.indexOf(ch);
    const pi = PERSIAN.indexOf(ch);
    if (ai >= 0) out += String(ai);
    else if (pi >= 0) out += String(pi);
    else out += ch;
  }
  return out;
}

/**
 * Parse a numeric cell that may contain: Arabic-Indic digits, thousands
 * separators, currency symbols/text, Arabic decimal separator, or
 * parentheses / trailing minus for negatives. Returns { value, ok, raw }.
 */
export function parseNumber(raw: unknown): { value: number; ok: boolean; empty: boolean } {
  if (raw === null || raw === undefined) return { value: 0, ok: true, empty: true };
  if (typeof raw === "number") return { value: raw, ok: Number.isFinite(raw), empty: false };
  let s = normalizeDigits(String(raw)).trim();
  if (s === "" || s === "-" || s === "—") return { value: 0, ok: true, empty: true };

  let negative = false;
  // Parentheses = negative accounting convention
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ""); }

  // Arabic decimal/thousands separators
  s = s.replace(/٫/g, ".").replace(/٬/g, ",");
  // Remove currency symbols, letters (SAR, ر.س, $, etc.), spaces, NBSP
  s = s.replace(/[^0-9.,\-]/g, "");
  // Remove thousands commas (keep last dot as decimal)
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    // comma could be decimal (e.g. "1,50") or thousands ("1,500")
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length !== 3) s = parts[0] + "." + parts[1];
    else s = s.replace(/,/g, "");
  }
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (s === "" || s === ".") return { value: 0, ok: true, empty: true };

  const n = Number(s);
  if (!Number.isFinite(n)) return { value: 0, ok: false, empty: false };
  return { value: negative ? -n : n, ok: true, empty: false };
}

/** Parse a date cell into YYYY-MM-DD, or null if unparseable/empty. */
export function parseDate(raw: unknown): { value: string | null; ok: boolean; empty: boolean } {
  if (raw === null || raw === undefined || String(raw).trim() === "") return { value: null, ok: true, empty: true };
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return { value: toISO(raw), ok: true, empty: false };
  }
  const s = normalizeDigits(String(raw)).trim();
  // ISO / yyyy-mm-dd or yyyy/mm/dd
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return { value: fmt(+m[1], +m[2], +m[3]), ok: true, empty: false };
  // dd/mm/yyyy or dd-mm-yyyy
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    const d = +m[1], mo = +m[2];
    // if first > 12 it must be day; otherwise assume dd/mm (common in region)
    if (d > 12 && mo <= 12) return { value: fmt(+m[3], mo, d), ok: true, empty: false };
    return { value: fmt(+m[3], mo, d), ok: true, empty: false };
  }
  // Excel serial number as text
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return { value: toISO(d), ok: true, empty: false };
    }
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return { value: toISO(parsed), ok: true, empty: false };
  return { value: null, ok: false, empty: false };
}

function fmt(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}
function toISO(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function parseText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}
