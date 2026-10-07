import { cctpAbi, erc20Abi, planExecutorAbi, type Plan, type WebAuthnAuth } from "@intentguard/core";
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from "viem";
import { waitForAttestation } from "./cctp";
import { nearTxUrl, type IntentGuardConfig } from "./config";
import { publicClient, signAndSend, type StepResult } from "./evm";
import type { PolicyClient } from "./near";

export type StepStatus = "running" | "done" | "skipped" | "failed";
export type RunEvents = {
  /** index -1 is the NEAR commit_plan. */
  onStep?: (index: number, status: StepStatus, info?: Partial<StepResult> & { error?: string; note?: string }) => void;
  log?: (msg: string) => void;
};

export const encodeExecute = (plan: NonNullable<Plan["executorPlan"]>, auth: WebAuthnAuth): Hex =>
  encodeFunctionData({ abi: planExecutorAbi, functionName: "execute", args: [plan, auth] });

/**
 * Runs an approved plan end to end: commit on NEAR, then every step through the policy + MPC, waiting for
 * each receipt. `auth` is the passkey assertion over plan.planId (needed only when the plan has an execute step).
 */
export async function runPlan(o: {
  cfg: IntentGuardConfig;
  policy: PolicyClient;
  plan: Plan;
  account: Address;
  auth?: WebAuthnAuth;
  iris: string;
  events?: RunEvents;
}): Promise<StepResult[]> {
  const { plan, events } = o;
  const results: StepResult[] = [];
  events?.onStep?.(-1, "running");
  const commitTx = await o.policy.commitPlan({ planId: plan.planId, ...plan.commit });
  events?.onStep?.(-1, "done", { nearTx: commitTx, nearExplorer: nearTxUrl(commitTx) });

  let burnTx: Hex | undefined;
  for (const [i, step] of plan.steps.entries()) {
    events?.onStep?.(i, "running");
    try {
      let data = step.data;
      if (step.kind === "approve" && step.data) {
        const [spender, amount] = decodeFunctionData({ abi: erc20Abi, data: step.data }).args as [Address, bigint];
        const allowance = await publicClient(step.chain, o.cfg).readContract({
          address: step.to, abi: erc20Abi, functionName: "allowance", args: [o.account, spender],
        });
        if (allowance >= amount) {
          events?.onStep?.(i, "skipped", { note: "allowance already sufficient" });
          continue;
        }
      }
      if (step.kind === "cctp-receive") {
        if (!burnTx) throw new Error("no burn to attest");
        const a = await waitForAttestation(o.iris, burnTx, { onTick: (ms) => events?.onStep?.(i, "running", { note: `waiting for Circle attestation… ${Math.round(ms / 1000)} s` }) });
        data = encodeFunctionData({ abi: cctpAbi, functionName: "receiveMessage", args: [a.message, a.attestation] });
      }
      if (step.kind === "execute") {
        if (!plan.executorPlan || !o.auth) throw new Error("execute needs the passkey approval");
        data = encodeExecute(plan.executorPlan, o.auth);
      }
      const r = await signAndSend({ cfg: o.cfg, policy: o.policy, account: o.account, chain: step.chain, planId: plan.planId, to: step.to, data, value: step.value, log: events?.log });
      if (step.kind === "cctp-burn") burnTx = r.txHash;
      results.push(r);
      events?.onStep?.(i, "done", r);
    } catch (e) {
      const nearTx = (e as { nearTx?: string }).nearTx;
      events?.onStep?.(i, "failed", { error: e instanceof Error ? e.message : String(e), ...(nearTx && { nearTx, nearExplorer: nearTxUrl(nearTx) }) });
      throw e;
    }
  }
  return results;
}

