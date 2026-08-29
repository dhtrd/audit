import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PRE-AUDIT OS",
  description: "منصة التدقيق الداخلي التمهيدي — جاهزية المراجعة الخارجية",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
