"use client";

import type { StepStatus } from "@intentguard/signer";
import { useI18n } from "./I18nProvider";
import { Ext } from "./ui";

export type Item = {
  label: string;
  chain: string;
  status: StepStatus | "pending";
  explorer?: string;
  nearExplorer?: string;
  note?: string;
  error?: string;
};

const ICON: Record<Item["status"], string> = { pending: "○", running: "◌", done: "●", skipped: "–", failed: "✕" };
const COLOR: Record<Item["status"], string> = {
  pending: "text-gray-500",
  running: "text-amber-300 animate-pulse",
  done: "text-emerald-400",
  skipped: "text-gray-400",
  failed: "text-red-400",
};

export function Timeline({ items }: { items: Item[] }) {
  const { t } = useI18n();
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span className={`w-4 shrink-0 ${COLOR[it.status]}`}>{ICON[it.status]}</span>
          <div className="min-w-0 space-y-0.5">
            <div>
              <span className="text-gray-400">[{it.chain}]</span> {it.label}
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {it.explorer && <Ext href={it.explorer}>{t("timeline.tx")}</Ext>}
              {it.nearExplorer && <Ext href={it.nearExplorer}>{t("timeline.nearTx")}</Ext>}
              {it.note && <span className="text-gray-400">{it.note}</span>}
            </div>
            {it.error && <div className="text-xs text-red-300">{it.error}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
