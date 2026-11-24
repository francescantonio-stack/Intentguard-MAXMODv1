"use client";

import { useCallback, useState } from "react";
import { Button, Card, Err, Mono } from "@/components/ui";

type Sourced = { value: string | number; source: string };
type Probe = {
  id: string; ok: boolean; error?: string; native: string; rpc: string; explorer: string;
  chainId?: Sourced; blockNumber?: Sourced; blockAgeSec?: Sourced; latencyMs?: Sourced; gasPrice?: Sourced;
};

function Num({ label, n }: { label: string; n?: Sourced }) {
  if (!n) return null;
  return (
    <div className="flex flex-col gap-0.5 py-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
      <span className="text-sm text-gray-300">{label}</span>
      <span className="text-right">
        <span className="font-mono text-sm text-emerald-300">{String(n.value)}</span>
        <span className="mt-0.5 block font-mono text-[11px] text-gray-500">fonte: {n.source}</span>
      </span>
    </div>
  );
}

export default function ProbePage() {
  const [rows, setRows] = useState<Probe[]>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [simIn, setSimIn] = useState(
    '{\n  "chainId": 10143,\n  "from": "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B",\n  "to": "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B",\n  "value": "0",\n  "data": "0x"\n}',
  );
  const [simOut, setSimOut] = useState<string>();
  const [simErr, setSimErr] = useState<string>();

  const run = useCallback(() => {
    setBusy(true); setErr(undefined);
    fetch("/api/probe")
      .then((r) => r.json())
      .then((j: { networks?: Probe[]; error?: string }) => {
        setRows(j.networks);
        setErr(j.error);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  }, []);

  const simulate = useCallback(() => {
    setSimErr(undefined); setSimOut(undefined);
    let body: unknown;
    try { body = JSON.parse(simIn); }
    catch (e) { setSimErr(`JSON non valido: ${e instanceof Error ? e.message : e}`); return; }
    fetch("/api/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => {
        const t = await r.text();
        if (!r.ok) throw new Error(t);
        setSimOut(t);
      })
      .catch((e) => setSimErr(String(e)));
  }, [simIn]);

  return (
    <>
      <Card title="Prova le reti (testnet)">
        <p className="text-xs text-gray-400">
          Solo lettura, RPC pubblici. Ogni numero mostra la sua fonte (metodo + endpoint). Nessuna firma, nessun invio.
        </p>
        <Button onClick={run} disabled={busy}>{busy ? "Controllo…" : "Controlla le reti"}</Button>
        <Err>{err}</Err>
        {rows?.map((r) => (
          <Card key={r.id} title={r.id} tone={r.ok ? "ok" : "danger"}>
            <p className="text-xs text-gray-400">{r.native} · <Mono>{r.rpc}</Mono></p>
            {r.error && <Err>{r.error}</Err>}
            <Num label="chain id" n={r.chainId} />
            <Num label="blocco" n={r.blockNumber} />
            <Num label="età del blocco (s)" n={r.blockAgeSec} />
            <Num label="latenza (ms)" n={r.latencyMs} />
            <Num label="gas price (wei)" n={r.gasPrice} />
          </Card>
        ))}
      </Card>
      <Card title="Simulazione prima della firma">
        <p className="text-xs text-gray-400">
          Invia una transazione proposta a <Mono>eth_call</Mono> / <Mono>eth_estimateGas</Mono>. Non viene firmata né inviata.
        </p>
        <textarea
          className="h-40 w-full rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-emerald-100"
          value={simIn}
          onChange={(e) => setSimIn(e.target.value)}
          spellCheck={false}
        />
        <Button onClick={simulate}>Simula</Button>
        <Err>{simErr}</Err>
        {simOut && <pre className="overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] text-emerald-200">{simOut}</pre>}
      </Card>
    </>
  );
}
