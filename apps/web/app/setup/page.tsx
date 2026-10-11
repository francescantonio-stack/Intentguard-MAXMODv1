"use client";
import { useEffect, useState } from "react";
import { KeyPair } from "near-api-js";
import { encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { MONAD_TESTNET, planExecutorAbi } from "@intentguard/core";
import { nearRpc, readState, signAndSend, userEvmAddress, type ChainState } from "@intentguard/signer";
import { useI18n } from "@/components/I18nProvider";
import { StatusBar } from "@/components/StatusBar";
import { InfoTip } from "@/components/InfoTip";
import { Action, Button, Card, Err, Ext, Mono } from "@/components/ui";
import { accountOf, errorText, policyClient } from "@/lib/clients";
import { cfg, FAUCETS, POLICY } from "@/lib/config";
import { createPasskey } from "@/lib/passkey";
import { loadSetup, saveSetup, type Setup } from "@/lib/store";

const cli = (user: string, fcPublicKey: string, derived: string) => [
  `# 0. (only if you have no testnet account yet)\nnear account create-account sponsor-by-faucet-service ${user} autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`,
  `# 1. allow this device to ask for plan signatures (function-call key, policy contract only)\nnear account add-key ${user} grant-function-call-access --allowance '1 NEAR' --contract-account-id ${POLICY} --function-names 'commit_plan, cancel_plan, request_signature' use-manually-provided-public-key ${fcPublicKey} network-config testnet sign-with-legacy-keychain send`,
  `# 2. register with a weekly cap of 5 USDC (needs your full-access key: 1 yoctoNEAR)\nnear contract call-function as-transaction ${POLICY} set_weekly_cap json-args '{"weekly_cap":"5000000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${user} network-config testnet sign-with-legacy-keychain send`,
  `# 3. allow your own derived address as recipient (CCTP mint, PlanExecutor)\nnear contract call-function as-transaction ${POLICY} add_recipient json-args '{"address":"${derived.toLowerCase()}"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${user} network-config testnet sign-with-legacy-keychain send`,
];

export default function SetupPage() {
  const { t } = useI18n();
  const [s, setS] = useState<Setup>({});
  const [user, setUser] = useState("");
  const [state, setState] = useState<ChainState>();
  const [nearOk, setNearOk] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const x = loadSetup();
    setS(x);
    setUser(x.nearUser ?? "");
  }, []);

  const derived = s.nearUser ? userEvmAddress(POLICY, s.nearUser) : undefined;
  const run = async (f: () => Promise<void>) => {
    setErr(undefined);
    setMsg(undefined);
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const checkNear = () =>
    run(async () => {
      const u = await policyClient(s).getUser();
      let key = "missing";
      try {
        await nearRpc(cfg().nearRpc, "query", { request_type: "view_access_key", finality: "final", account_id: s.nearUser, public_key: s.fcPublicKey });
        key = "ok";
      } catch {
        /* not added yet */
      }
      const rec = u?.recipients.includes(derived!.toLowerCase());
      setNearOk(
        t("setup.nearStatus", {
          key: key === "ok" ? t("setup.keyOk") : t("setup.keyMissing"),
          registered: u ? t("setup.registeredYes", { cap: String(Number(u.weekly_cap) / 1e6) }) : t("setup.registeredNo"),
          allowed: rec ? t("setup.yes") : t("setup.no"),
        }),
      );
      setState(await readState(cfg(), policyClient(s), accountOf(s)));
    });

  const registerOnMonad = () =>
    run(async () => {
      const st = await readState(cfg(), policyClient(s), accountOf(s));
      if (!st.near) throw new Error(t("setup.needNearFirst"));
      if (st.executor.registered) return setMsg(t("setup.alreadyRegistered"));
      const { x, y } = s.passkey!;
      const account = accountOf(s);
      const cap = BigInt(st.near.weekly_cap) < 5_000_000n ? BigInt(st.near.weekly_cap) : 5_000_000n;
      const planId = keccak256(
        encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }], ["intentguard:register-passkey", account, x, y]),
      );
      const policy = policyClient(s);
      await policy.commitPlan({ planId, usdcBudget: 0n, ttlSeconds: 600n, maxSignatures: 1 });
      const r = await signAndSend({
        cfg: cfg(), policy, account, chain: "monad-testnet", planId, to: MONAD_TESTNET.planExecutor,
        data: encodeFunctionData({ abi: planExecutorAbi, functionName: "registerPasskey", args: [x, y, cap] }),
      });
      setMsg(`${t("setup.registeredOk")} ${r.explorer}`);
      setState(await readState(cfg(), policy, account));
    });

  return (
    <>
      <Card title={t("setup.nearTitle")} info="nearAccount">
        <div className="flex flex-wrap gap-2">
          <input
            value={user}
            onChange={(e) => setUser(e.target.value.trim())}
            placeholder={t("setup.placeholder")}
            className="min-w-60 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm"
          />
          <Action info="saveAccount">
            <Button onClick={() => user.endsWith(".testnet") && setS(saveSetup({ nearUser: user }))} disabled={!user.endsWith(".testnet")}>
              {t("setup.save")}
            </Button>
          </Action>
        </div>
        {derived && (
          <p className="flex flex-wrap items-start gap-1 text-xs text-gray-300">
            <span>
              {t("setup.derived")} <Mono>{derived}</Mono>
            </span>
            <InfoTip k="derivedAddress" />
          </p>
        )}
      </Card>

      {s.nearUser && (
        <Card title={t("setup.policyTitle")} info="nearCommands">
          {!s.fcKey ? (
            <Action info="deviceKey">
              <Button
                onClick={() => {
                  const kp = KeyPair.fromRandom("ed25519");
                  setS(saveSetup({ fcKey: kp.toString(), fcPublicKey: kp.getPublicKey().toString() }));
                }}
              >
                {t("setup.generateKey")}
              </Button>
            </Action>
          ) : (
            <>
              <p className="text-xs text-gray-400">{t("setup.keyStay", { policy: POLICY })}</p>
              {cli(s.nearUser, s.fcPublicKey!, derived!).map((c) => (
                <pre key={c} className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-black/50 p-3 text-xs text-gray-200">
                  {c}
                </pre>
              ))}
              <Action info="checkNear">
                <Button kind="ghost" onClick={checkNear} disabled={busy}>
                  {t("setup.checkNear")}
                </Button>
              </Action>
              {nearOk && <p className="text-xs text-emerald-300">{nearOk}</p>}
            </>
          )}
        </Card>
      )}

      {s.fcKey && (
        <Card title={t("setup.passkeyTitle")} info="createPasskey">
          {s.passkey ? (
            <p className="text-xs text-gray-300">
              {t("setup.passkeyDone")} <Mono>{s.passkey.x}</Mono>
            </p>
          ) : (
            <Action info="createPasskey">
              <Button
                onClick={() =>
                  run(async () => {
                    const p = await createPasskey(s.nearUser!);
                    setS(saveSetup({ credentialId: p.credentialId, passkey: { x: p.x, y: p.y } }));
                  })
                }
                disabled={busy}
              >
                {t("setup.createPasskey")}
              </Button>
            </Action>
          )}
        </Card>
      )}

      {s.passkey && derived && (
        <Card title={t("setup.fundsTitle")} info="faucet">
          <p className="text-xs text-gray-300">
            {t("setup.fundsLead")} <Mono>{derived}</Mono>: {t("setup.fundsMon")} (
            <Ext href={FAUCETS.mon}>{t("app.faucet")}</Ext>), {t("setup.fundsUsdc")} (
            <Ext href={FAUCETS.usdc}>Circle</Ext>), {t("setup.fundsEth")} (
            <Ext href={FAUCETS.baseEth}>CDP</Ext>).
          </p>
          <Action info="refreshBalances">
            <Button kind="ghost" onClick={checkNear} disabled={busy}>
              {t("setup.refresh")}
            </Button>
          </Action>
          {state && <StatusBar s={state} />}
        </Card>
      )}

      {s.passkey && (
        <Card title={t("setup.registerTitle")} info="registerMonad">
          <p className="text-xs text-gray-400">{t("setup.registerLead")}</p>
          <Action info="registerMonad">
            <Button onClick={registerOnMonad} disabled={busy}>
              {t("setup.register")}
            </Button>
          </Action>
        </Card>
      )}

      {busy && <p className="text-sm text-amber-300">{t("setup.working")}</p>}
      {msg && <p className="text-sm text-emerald-300">{msg}</p>}
      <Err>{err}</Err>
    </>
  );
}
