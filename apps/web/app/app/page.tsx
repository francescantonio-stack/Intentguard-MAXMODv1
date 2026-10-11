"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { buildPlan, decodeIntentParam, fromUnits, summarizePlan, toUnits, type Intent, type Plan } from "@intentguard/core";
import { cctpFastMaxFee, planContext, PolicyRejection, readState, runPlan, type ChainState } from "@intentguard/signer";
import { InfoTip } from "@/components/InfoTip";
import { useI18n } from "@/components/I18nProvider";
import { StatusBar } from "@/components/StatusBar";
import { Timeline, type Item } from "@/components/Timeline";
import { Action, Button, Card, Err, Ext, Mono } from "@/components/ui";
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

function App() {
  const { t } = useI18n();
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
    setBusy(t("app.busyRead"));
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
        setText(intent.rawText || t("app.agentText"));
        void makePlan(s, intent, "agent");
      } catch (e) {
        setErr(t("app.invalidLink", { error: errorText(e) }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPlan() {
    setErr(undefined);
    setFromAgent(false);
    setBusy(t("app.busyParse"));
    const res = await fetch("/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const j = (await res.json()) as { intent?: Intent; source?: string; error?: string };
    if (!res.ok || !j.intent) {
      setErr(j.error ?? t("app.parseError"));
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
      { label: t("app.commitStep"), chain: "near", status: "pending" },
      ...plan.steps.map((s) => ({ label: s.label, chain: s.chain, status: "pending" as const })),
    ]);
    try {
      setBusy(t("app.busyApprove"));
      const auth = await approvePlan(setup.credentialId, plan.planId); // one approval for the whole plan
      setBusy(t("app.busyExecute"));
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
      setErr(e instanceof PolicyRejection ? t("app.policyRejected", { reason: e.reason }) : errorText(e));
    } finally {
      setBusy(undefined);
    }
  }

  if (!isReady(setup)) {
    return (
      <Card title={t("app.welcomeTitle")} info="welcome">
        <p className="text-sm text-gray-300">{t("app.welcomeBody")}</p>
        <Action info="setupCta">
          <Link href="/setup" className="inline-block rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-black">
            {t("app.setupLink")}
          </Link>
        </Action>
      </Card>
    );
  }

  const sourceKey = planned?.source === "llm" ? "app.sourceLlm" : planned?.source === "agent" ? "app.sourceAgent" : "app.sourceRules";

  return (
    <>
      {state && <StatusBar s={state} />}
      <Card title={t("app.intentTitle")} info="intent">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-white/10 bg-black/40 p-3 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <Action info="planIt">
            <Button onClick={onPlan} disabled={!!busy}>
              {t("app.planIt")}
            </Button>
          </Action>
          <Action info="demoCommand">
            <Button kind="ghost" onClick={() => setText(DEMO_COMMAND)} disabled={!!busy}>
              {t("app.demoCommand")}
            </Button>
          </Action>
        </div>
      </Card>

      {busy && <p className="text-sm text-amber-300">{busy}</p>}
      <Err>{err}</Err>

      {planned && (
        <Card title={fromAgent ? t("app.agentPlan") : t("app.yourPlan")} info="planPreview" tone="ok">
          <p className="text-xs text-gray-400">{t("app.understood", { source: t(sourceKey) })}</p>
          <ul className="space-y-1 text-sm">
            {summarizePlan(planned.plan).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-start gap-1 text-xs text-gray-400">
            <span>
              {t("app.planHash")} <Mono>{planned.plan.planId}</Mono>
            </span>
            <InfoTip k="planHash" />
          </div>
          {planned.plan.weeklyCap !== undefined && state?.near && BigInt(state.near.weekly_cap) !== planned.plan.weeklyCap && (
            <p className="flex flex-wrap items-start gap-1 text-xs text-amber-300">
              <span>{t("app.capMismatch", { amount: fromUnits(BigInt(state.near.weekly_cap), "USDC") })}</span>
              <InfoTip k="weeklyCap" />
            </p>
          )}
          <Warnings plan={planned.plan} s={state} />
          <Action info="approve">
            <Button onClick={onApprove} disabled={!!busy || items.length > 0}>
              {t("app.approve")}
            </Button>
          </Action>
        </Card>
      )}

      {items.length > 0 && (
        <Card title={t("app.execution")} info="execution">
          <Timeline items={items} />
        </Card>
      )}
    </>
  );
}

function Warnings({ plan, s }: { plan: Plan; s?: ChainState }) {
  const { t } = useI18n();
  if (!s) return null;
  const bridge = plan.intent.actions.find((a) => a.type === "bridge");
  return (
    <>
      {plan.executorPlan && !s.executor.registered && <Warn>{t("app.warnNoPasskey")}</Warn>}
      {bridge && toUnits(bridge.amount, "USDC") > s.balances.baseUsdc && (
        <Warn>
          {t("app.warnLowUsdc")}{" "}
          <Ext href={FAUCETS.usdc}>{t("app.faucet")}</Ext>
        </Warn>
      )}
      {bridge && s.balances.baseEth === 0n && (
        <Warn>
          {t("app.warnNoEth")}{" "}
          <Ext href={FAUCETS.baseEth}>{t("app.faucet")}</Ext>
        </Warn>
      )}
      {s.balances.monadMon < 50_000_000_000_000_000n && (
        <Warn>
          {t("app.warnLowMon")}{" "}
          <Ext href={FAUCETS.mon}>{t("app.faucet")}</Ext>
        </Warn>
      )}
    </>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-amber-300">⚠ {children}</p>;
}
