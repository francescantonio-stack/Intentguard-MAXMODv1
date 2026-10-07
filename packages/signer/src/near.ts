import { Account, JsonRpcProvider, KeyPairSigner, actions, baseEncode, encodeTransaction, type KeyPairString } from "near-api-js";
import { sha256 } from "@noble/hashes/sha256";
import type { Hex } from "viem";

// ---- types mirrored from contracts/near-policy/src/lib.rs ----

export type TxRequest = {
  chain_id: number;
  nonce: number;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: number;
  to: string;
  value: string;
  data: Hex;
};
export type UserView = {
  weekly_cap: string;
  spent_in_period: string;
  remaining: string;
  period_start_ns: number;
  recipients: string[];
  derivation_path: string;
};
export type PlanCommitment = {
  plan_hash: string;
  usdc_budget: string;
  expires_at_ns: number;
  max_signatures: number;
  signatures_used: number;
};
export type CheckView = { ok: boolean; payload?: string | null; reason?: string | null };
export type MpcSignature = { big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number };

export class PolicyRejection extends Error {
  constructor(public readonly reason: string, public readonly nearTx?: string) {
    super(`policy: ${reason}`);
    this.name = "PolicyRejection";
  }
}

// ---- RPC (works in browsers and Node: fetch + atob/btoa only) ----

const utf8 = new TextEncoder();
const toB64 = (s: string) => btoa(String.fromCharCode(...utf8.encode(s)));
const fromB64 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

export async function nearRpc<T>(rpc: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ig", method, params }),
  });
  const j = (await res.json()) as { result?: T & { error?: string }; error?: unknown };
  if (j.error || j.result?.error) throw new Error(`NEAR RPC ${method}: ${JSON.stringify(j.error ?? j.result?.error).slice(0, 300)}`);
  return j.result as T;
}

export async function nearView<T>(rpc: string, contract: string, method: string, args: object): Promise<T> {
  const r = await nearRpc<{ result: number[] }>(rpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: toB64(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
}

type Outcome = { status: { SuccessValue?: string; Failure?: unknown } | string };

/** "Smart contract panicked: policy: weekly cap exceeded …" -> "weekly cap exceeded …" */
export function failureReason(failure: unknown): string {
  const s = JSON.stringify(failure);
  const m = s.match(/policy: ([^"\\]*)/) ?? s.match(/panicked: ([^"\\]*)/) ?? s.match(/ExecutionError":"([^"\\]*)/);
  return m?.[1] ?? s.slice(0, 300);
}

function parseOutcome(o: Outcome): { value?: unknown; error?: string } {
  if (typeof o.status !== "object") return { error: `unexpected status ${o.status}` };
  if (o.status.Failure !== undefined) return { error: failureReason(o.status.Failure) };
  const v = o.status.SuccessValue;
  return { value: v ? JSON.parse(fromB64(v)) : undefined };
}

// ---- function calls ----

export type NearCallResult = { txHash: string; value?: unknown; error?: string };

/** Anything that can sign NEAR function calls for the user: a function-call key in the app, a wallet, a CLI. */
export type NearSender = {
  accountId: string;
  call(method: string, args: object, opts?: { gas?: bigint; deposit?: bigint }): Promise<NearCallResult>;
};

/**
 * NearSender backed by an access key (in the app: a function-call key limited to the policy contract,
 * generated on the device). The tx hash is computed locally so a slow MPC response never loses it.
 */
export function keySender(nearRpc: string, accountId: string, secretKey: string, contractId: string): NearSender {
  const provider = new JsonRpcProvider({ url: nearRpc });
  const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as KeyPairString));
  return {
    accountId,
    async call(method, args, { gas = 30_000_000_000_000n, deposit = 0n } = {}) {
      const signed = await account.createSignedTransaction({
        receiverId: contractId,
        actions: [actions.functionCall(method, args, gas, deposit)],
      });
      const txHash = baseEncode(sha256(encodeTransaction(signed.transaction)));
      await provider.sendTransactionUntil(signed, "INCLUDED");
      for (let i = 0; ; i++) {
        try {
          const o = await provider.viewTransactionStatus({ txHash, accountId, waitUntil: "EXECUTED_OPTIMISTIC" });
          return { txHash, ...parseOutcome(o as unknown as Outcome) };
        } catch (e) {
          if (i >= 20) throw e; // RPC timeouts while the MPC network signs: keep polling
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    },
  };
}

// ---- policy contract client ----

export class PolicyClient {
  constructor(
    readonly rpc: string,
    readonly policy: string,
    readonly user: string,
    readonly sender?: NearSender,
  ) {}

  view<T>(method: string, args: object = {}) {
    return nearView<T>(this.rpc, this.policy, method, args);
  }
  getUser() {
    return this.view<UserView | null>("get_user", { user: this.user });
  }
  getPlan() {
    return this.view<PlanCommitment | null>("get_plan", { user: this.user });
  }
  /** Free dry run of request_signature: same checks, returns the EIP-1559 payload or the rejection reason. */
  check(planHash: Hex, tx: TxRequest) {
    return this.view<CheckView>("check", { user: this.user, plan_hash: planHash, tx });
  }

  private need(): NearSender {
    if (!this.sender) throw new Error("no NEAR key configured for this user");
    return this.sender;
  }

  /** One active plan per user: an unfinished one is cancelled first (its cap is not refunded). */
  async commitPlan(c: { planId: Hex; usdcBudget: bigint; ttlSeconds: bigint; maxSignatures: number }): Promise<string> {
    const p = await this.getPlan();
    if (p && p.signatures_used < p.max_signatures && p.expires_at_ns > Date.now() * 1e6) await this.need().call("cancel_plan", {});
    const r = await this.need().call("commit_plan", {
      plan_hash: c.planId,
      usdc_budget: c.usdcBudget.toString(),
      ttl_seconds: Number(c.ttlSeconds),
      max_signatures: c.maxSignatures,
    });
    if (r.error) throw new PolicyRejection(r.error, r.txHash);
    return r.txHash;
  }

  /** Policy check on-chain, then the MPC network signs. A rejection is a real NEAR tx (visible on nearblocks). */
  async requestSignature(planHash: Hex, tx: TxRequest): Promise<{ txHash: string; signature: MpcSignature }> {
    const r = await this.need().call("request_signature", { plan_hash: planHash, tx }, { gas: 100_000_000_000_000n });
    if (r.error) throw new PolicyRejection(r.error, r.txHash);
    if (!r.value) throw new Error(`MPC returned no signature (near tx ${r.txHash})`);
    return { txHash: r.txHash, signature: r.value as MpcSignature };
  }
}
