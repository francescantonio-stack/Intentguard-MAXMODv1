import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { SwRegister } from "@/components/SwRegister";
import { COOKIE_LOCALE, isLocale, type Locale } from "@/lib/i18n/locale";

export const metadata: Metadata = {
  title: "IntentGuard",
  description: "Passkey-approved plans for AI agents, enforced on NEAR and Monad (testnet only).",
};
export const viewport: Viewport = { themeColor: "#0b0f14", width: "device-width", initialScale: 1 };

async function bootLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(COOKIE_LOCALE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const fromHeader = (await headers()).get("x-intentguard-locale");
  return isLocale(fromHeader) ? fromHeader : "en";
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await bootLocale();
  return (
    <html lang={locale}>
      <body className="min-h-screen">
        <AppShell initialLocale={locale}>{children}</AppShell>
        <SwRegister />
      </body>
    </html>
  );
}
