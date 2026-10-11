"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import { InfoTip } from "./InfoTip";
import { I18nProvider, useI18n } from "./I18nProvider";
import { LangSwitch } from "./LangSwitch";

const NAV = [
  ["/", "nav.home"],
  ["/app", "nav.app"],
  ["/setup", "nav.setup"],
  ["/guard", "nav.guard"],
  ["/attack", "nav.attack"],
] as const;

export function AppShell({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
  return (
    <I18nProvider initialLocale={initialLocale}>
      <Shell>{children}</Shell>
    </I18nProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const wide = pathname === "/";

  return (
    <>
      <header className="border-b border-white/10">
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <Link href="/" className="font-semibold text-emerald-400 hover:text-emerald-300">
            IntentGuard
          </Link>
          {NAV.map(([href, key]) => (
            <Link
              key={href}
              href={href}
              className={`hover:text-white ${pathname === href ? "text-white" : "text-gray-300"}`}
              aria-current={pathname === href ? "page" : undefined}
            >
              {t(key)}
            </Link>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <LangSwitch />
            <span className="inline-flex items-center gap-1">
              <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">{t("nav.testnet")}</span>
              <InfoTip k="testnet" />
            </span>
          </div>
        </nav>
      </header>
      <main className={`mx-auto space-y-4 px-4 py-6 ${wide ? "max-w-5xl" : "max-w-3xl"}`}>{children}</main>
    </>
  );
}
