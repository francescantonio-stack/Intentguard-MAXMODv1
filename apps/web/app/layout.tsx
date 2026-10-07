import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { SwRegister } from "@/components/SwRegister";

export const metadata: Metadata = {
  title: "IntentGuard",
  description: "Passkey-approved plans for AI agents, enforced on NEAR and Monad (testnet only).",
};
export const viewport: Viewport = { themeColor: "#0b0f14", width: "device-width", initialScale: 1 };

const nav = [
  ["/", "App"],
  ["/setup", "Setup"],
  ["/guard", "Guard log"],
  ["/attack", "Attack demo"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-white/10">
          <nav className="mx-auto flex max-w-3xl flex-wrap items-center gap-4 px-4 py-3 text-sm">
            <span className="font-semibold text-emerald-400">IntentGuard</span>
            {nav.map(([href, label]) => (
              <Link key={href} href={href} className="text-gray-300 hover:text-white">
                {label}
              </Link>
            ))}
            <span className="ml-auto rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">testnet only</span>
          </nav>
        </header>
        <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">{children}</main>
        <SwRegister />
      </body>
    </html>
  );
}
