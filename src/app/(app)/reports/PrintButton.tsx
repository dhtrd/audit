"use client";

// Minimal client component: triggers the browser's print dialog so the
// user can save the RTL report as a perfectly-rendered Arabic PDF.
export default function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="bg-gray-800 text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 print:hidden"
    >
      طباعة / حفظ PDF
    </button>
  );
}
