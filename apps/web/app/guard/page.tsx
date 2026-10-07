"use client";
import { useEffect, useState } from "react";
import type { GuardEntry } from "@intentguard/signer";
import { Card, Err, Ext } from "@/components/ui";
import { POLICY } from "@/lib/config";

export default function GuardPage() {
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
    <Card title="Guard log: live decisions of the on-chain policy">
      <p className="text-xs text-gray-400">
        Every signature request from any agent or app goes through <Ext href={`https://testnet.nearblocks.io/address/${POLICY}`}>{POLICY}</Ext>. Rejected
        requests are real NEAR transactions: the chain said no.
      </p>
      <Err>{err}</Err>
      <ul className="divide-y divide-white/5 text-sm">
        {entries.map((e) => (
          <li key={e.txHash} className="flex flex-wrap items-baseline gap-x-3 py-2">
            <span className={`w-20 font-semibold ${e.ok ? "text-emerald-400" : "text-red-400"}`}>{e.ok ? "ALLOWED" : "REJECTED"}</span>
            <span className="font-mono text-xs">{e.method}</span>
            <span className="text-xs text-gray-400">{e.signer}</span>
            <span className="text-xs text-gray-500">{e.time?.replace("T", " ").slice(0, 19)}</span>
            <Ext href={e.url}>tx</Ext>
            {e.reason && <span className="basis-full text-xs text-red-300">{e.reason}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
