"use client";
import { useEffect, useState } from "react";
import type { GuardEntry } from "@intentguard/signer";
import { useI18n } from "@/components/I18nProvider";
import { Card, Err, Ext } from "@/components/ui";
import { POLICY } from "@/lib/config";

export default function GuardPage() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<GuardEntry[]>([]);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    const load = () =>
      fetch("/api/guard")
        .then((r) => r.json())
        .then((j: { entries: GuardEntry[]; error?: string }) => {
          setEntries(j.entries);
          setErr(j.error);
        })
        .catch((e) => setErr(String(e)));
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card title={t("guard.title")} info="guardLog">
      <p className="text-xs text-gray-400">
        {t("guard.lead").split("{policy}")[0]}
        <Ext href={`https://testnet.nearblocks.io/address/${POLICY}`}>{POLICY}</Ext>
        {t("guard.lead").split("{policy}")[1]}
      </p>
      <Err>{err}</Err>
      <ul className="divide-y divide-white/5 text-sm">
        {entries.map((e) => (
          <li key={e.txHash} className="flex flex-wrap items-baseline gap-x-3 py-2">
            <span className={`w-20 font-semibold ${e.ok ? "text-emerald-400" : "text-red-400"}`}>
              {e.ok ? t("guard.allowed") : t("guard.rejected")}
            </span>
            <span className="font-mono text-xs">{e.method}</span>
            <span className="text-xs text-gray-400">{e.signer}</span>
            <span className="text-xs text-gray-500">{e.time?.replace("T", " ").slice(0, 19)}</span>
            <Ext href={e.url}>{t("guard.tx")}</Ext>
            {e.reason && <span className="basis-full text-xs text-red-300">{e.reason}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
