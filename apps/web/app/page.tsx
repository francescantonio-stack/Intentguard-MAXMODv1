"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { buildPlan, decodeIntentParam, fromUnits, summarizePlan, toUnits, type Intent, type Plan } from "@intentguard/core";
import { cctpFastMaxFee, planContext, PolicyRejection, readState, runPlan, type ChainState } from "@intentguard/signer";
import { StatusBar } from "@/components/StatusBar";
import { Timeline, type Item } from "@/components/Timeline";
import { Button, Card, Err, Mono } from "@/components/ui";
import { accountOf, errorText, policyClient } from "@/lib/clients";
import { cfg, DEMO_COMMAND, FAUCETS } from "@/lib/config";
import { approvePlan } from "@/lib/passkey";
import { isReady, loadSetup, type Setup } from "@/lib/store";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <App />
    </Suspense>
  );
}

function warnings(plan: Plan, s?: ChainState): string[] {
  if (!s) return [];
  const w: string[] = [];
  const bridge = plan.intent.actions.find((a) => a.type === "bridge");
  if (plan.executorPlan && !s.executor.registered) w.push("Your passkey is not registered on Monad yet: finish Setup (step 5).");
  if (bridge && toUnits(bridge.amount, "USDC") > s.balances.baseUsdc) w.push(`Not enough USDC on Base Sepolia (faucet: ${FAUCETS.usdc}).`);
  if (bridge && s.balances.baseEth === 0n) w.push(`No ETH for gas on Base Sepolia (faucet: ${FAUCETS.baseEth}).`);
  if (s.balances.monadMon < 50_000_000_000_000_000n) w.push(`Low MON for gas on Monad (faucet: ${FAUCETS.mon}).`);
  return w;
}

function App() {
  const params = useSearchParams();
  const [setup, setSetup] = useState<Setup>({});
  const [state, setState] = useState<ChainState>();
  const [text, setText] = useState(DEMO_COMMAND);
  const [fromAgent, setFromAgent] = useState(false);
  const [planned, setPlanned] = useState<{ plan: Plan; source: string }>();
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function refresh(s: Setup) {
    if (s.nearUser) setState(await readState(cfg(), policyClient(s), accountOf(s)));
  }

  async function makePlan(s: Setup, intent: Intent, source: string) {
    setErr(undefined);
    setPlanned(undefined);
    setItems([]);
    setBusy("Reading NEAR, Monad and Base Sepolia…");
    try {
      const st = await readState(cfg(), policyClient(s), accountOf(s));
      setState(st);
      const bridge = intent.actions.find((a) => a.type === "bridge");
      const fee = bridge ? await cctpFastMaxFee(cfg().irisApi, toUnits(bridge.amount, "USDC")) : undefined;
      setPlanned({ plan: buildPlan(intent, planContext(st, { cctpMaxFee: fee })), source });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => {
    const s = loadSetup();
    setSetup(s);
    refresh(s).catch((e) => setErr(errorText(e)));
    const p = params.get("intent");
    if (p && s.nearUser) {
      try {
        const intent = decodeIntentParam(p);
        setFromAgent(true);
        setText(intent.rawText || "(structured intent proposed by an AI agent)");
        void makePlan(s, intent, "agent");
      } catch (e) {
        setErr(`Invalid approval link: ${errorText(e)}`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPlan() {
    setErr(undefined);
    setFromAgent(false);
    setBusy("Understanding the command…");
    const res = await fetch("/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const j = (await res.json()) as { intent?: Intent; source?: string; error?: string };
    if (!res.ok || !j.intent) {
      setErr(j.error ?? "could not understand the command");
      setBusy(undefined);
      return;
    }
    await makePlan(setup, j.intent, j.source ?? "rules");
  }

  async function onApprove() {
    if (!planned || !setup.credentialId) return;
    const { plan } = planned;
    setErr(undefined);
    setItems([
      { label: "Commit the plan on the NEAR policy contract", chain: "near", status: "pending" },
      ...plan.steps.map((s) => ({ label: s.label, chain: s.chain, status: "pending" as const })),
    ]);
    try {
      setBusy("Approve with your passkey (fingerprint / face / PIN)…");
      const auth = await approvePlan(setup.credentialId, plan.planId); // one approval for the whole plan
      setBusy("Executing: every signature goes through the NEAR policy, one tx at a time…");
      await runPlan({
        cfg: cfg(),
        policy: policyClient(setup),
        plan,
        account: accountOf(setup),
        auth: plan.executorPlan ? auth : undefined,
        iris: cfg().irisApi,
        events: {
          onStep: (i, status, info) =>
            setItems((prev) =>
              prev.map((it, k) =>
                k === i + 1
                  ? { ...it, status, explorer: info?.explorer ?? it.explorer, nearExplorer: info?.nearExplorer ?? it.nearExplorer, note: info?.note, error: info?.error }
                  : it,
              ),
            ),
        },
      });
      await refresh(setup);
    } catch (e) {
      setErr(e instanceof PolicyRejection ? `Rejected by the NEAR policy: ${e.reason}` : errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  if (!isReady(setup)) {
    return (
      <Card title="Welcome to IntentGuard">
        <p className="text-sm text-gray-300">
          AI agents propose, you approve once with a passkey, and two chains refuse everything outside your plan.
        </p>
        <Link href="/setup" className="inline-block rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black">
          Set up this device
        </Link>
      </Card>
    );
  }

  const w = planned ? warnings(planned.plan, state) : [];
  return (
    <>
      {state && <StatusBar s={state} />}
      <Card title="What should your agent do?">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-white/10 bg-black/40 p-3 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={onPlan} disabled={!!busy}>
            Plan it
          </Button>
          <Button kind="ghost" onClick={() => setText(DEMO_COMMAND)} disabled={!!busy}>
            Demo command
          </Button>
        </div>
      </Card>

      {busy && <p className="text-sm text-amber-300">{busy}</p>}
      <Err>{err}</Err>

      {planned && (
        <Card title={fromAgent ? "Plan proposed by an AI agent" : "Your plan"} tone="ok">
          <p className="text-xs text-gray-400">
            Understood by: {planned.source === "llm" ? "LLM (schema-validated)" : planned.source === "agent" ? "external agent (re-validated here)" : "deterministic parser"} · checked against your on-chain limits
          </p>
          <ul className="space-y-1 text-sm">
            {summarizePlan(planned.plan).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <div className="text-xs text-gray-400">
            Passkey challenge (plan hash): <Mono>{planned.plan.planId}</Mono>
          </div>
          {planned.plan.weeklyCap !== undefined && state?.near && BigInt(state.near.weekly_cap) !== planned.plan.weeklyCap && (
            <p className="text-xs text-amber-300">
              Your on-chain weekly cap is {fromUnits(BigInt(state.near.weekly_cap), "USDC")} USDC; changing it needs your full-access NEAR key (see Setup).
            </p>
          )}
          {w.map((x) => (
            <p key={x} className="text-xs text-amber-300">
              ⚠ {x}
            </p>
          ))}
          <Button onClick={onApprove} disabled={!!busy || items.length > 0}>
            Approve with passkey
          </Button>
        </Card>
      )}

      {items.length > 0 && (
        <Card title="Execution">
          <Timeline items={items} />
        </Card>
      )}
    </>
  );
}
