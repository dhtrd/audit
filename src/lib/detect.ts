// PRE-AUDIT OS — Phase 2 file-type detection + mapping suggestion.
//
// Detection is a transparent, explainable heuristic (not a black box):
// it counts which standard-field aliases appear among the file's headers
// and reports WHY it chose a type. The user always confirms or overrides.

import type { ImportFileType } from "./repo";
import { STANDARD_FIELDS } from "./import-fields";
import { normalizeHeader } from "./excel";

export interface DetectionResult {
  detectedType: ImportFileType | "UNKNOWN";
  confidence: number; // 0..1
  reason: string;
  suggestedMapping: Record<string, string>; // standardFieldKey -> header
}

// Headers that specifically point to one type.
const TB_ONLY_FIELDS = ["opening_balance", "closing_balance"]; // "balance" => TB
const GL_ONLY_FIELDS = ["entry_date", "journal", "partner", "reference", "description"]; // date/journal/partner => GL

/** Match a header string to a standard field key, if any alias matches. */
export function matchHeaderToField(header: string): string | null {
  const norm = normalizeHeader(header);
  if (!norm) return null;
  // exact alias match first
  for (const field of Object.values(STANDARD_FIELDS)) {
    if (field.aliases.some((a) => normalizeHeader(a) === norm)) return field.key;
  }
  // then contains-match (longer aliases only, to avoid false hits)
  for (const field of Object.values(STANDARD_FIELDS)) {
    if (field.aliases.some((a) => {
      const na = normalizeHeader(a);
      return na.length >= 3 && (norm.includes(na) || na.includes(norm));
    })) return field.key;
  }
  return null;
}

export function detectFileType(headers: string[]): DetectionResult {
  const matched: Record<string, string> = {}; // fieldKey -> header (first wins)
  for (const h of headers) {
    const key = matchHeaderToField(h);
    if (key && !matched[key]) matched[key] = h;
  }

  const tbSignals = TB_ONLY_FIELDS.filter((k) => matched[k]);
  const glSignals = GL_ONLY_FIELDS.filter((k) => matched[k]);

  let detectedType: ImportFileType | "UNKNOWN";
  let reason: string;
  const tbScore = tbSignals.length;
  const glScore = glSignals.length;

  if (glScore > tbScore) {
    detectedType = "GENERAL_LEDGER";
    reason = `تم العثور على أعمدة تخص الأستاذ العام: ${glSignals.map(fieldLabel).join("، ")}`;
  } else if (tbScore > glScore) {
    detectedType = "TRIAL_BALANCE";
    reason = `تم العثور على أعمدة تخص ميزان المراجعة: ${tbSignals.map(fieldLabel).join("، ")}`;
  } else if (tbScore === 0 && glScore === 0) {
    // No distinguishing column; if we at least have debit+credit+account guess TB
    if (matched["account_code"] && matched["debit"] && matched["credit"]) {
      detectedType = "TRIAL_BALANCE";
      reason = "لا يوجد عمود مميز (تاريخ/يومية أو رصيد)، لكن توجد أعمدة الحساب والمدين والدائن — رُجّح ميزان المراجعة مبدئيًا";
    } else {
      detectedType = "UNKNOWN";
      reason = "تعذّر تحديد النوع تلقائيًا من الأعمدة — الرجاء اختيار النوع يدويًا";
    }
  } else {
    detectedType = "UNKNOWN";
    reason = "إشارات متعارضة في الأعمدة — الرجاء تأكيد النوع يدويًا";
  }

  const total = tbScore + glScore;
  const confidence = total === 0
    ? (detectedType === "UNKNOWN" ? 0 : 0.4)
    : Math.max(tbScore, glScore) / total;

  // Build a suggested mapping limited to fields valid for the detected type
  const suggestedMapping: Record<string, string> = {};
  const typeForMapping: ImportFileType = detectedType === "UNKNOWN" ? "TRIAL_BALANCE" : detectedType;
  for (const field of Object.values(STANDARD_FIELDS)) {
    if (field.types.includes(typeForMapping) && matched[field.key]) {
      suggestedMapping[field.key] = matched[field.key];
    }
  }

  return { detectedType, confidence: Math.round(confidence * 100) / 100, reason, suggestedMapping };
}

function fieldLabel(key: string): string {
  return STANDARD_FIELDS[key]?.label ?? key;
}
