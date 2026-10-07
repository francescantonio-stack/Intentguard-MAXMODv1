import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, parseGwei, serializeTransaction, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { cctpFastMaxFee, waitForAttestation } from "../src/cctp";
import { assembleSignedTx, mpcToSignature } from "../src/evm";
import { failureReason, PolicyClient, PolicyRejection, type MpcSignature, type NearSender } from "../src/near";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const me = privateKeyToAccount(PK).address;
const unsigned: TransactionSerializableEIP1559 = {
  type: "eip1559", chainId: 10143, nonce: 4, maxPriorityFeePerGas: parseGwei("2"), maxFeePerGas: parseGwei("202"),
  gas: 210_000n, to: "0x3f1391EC12002E10E18Efa82Af5E491f8159faC1", value: 0n, data: "0x1234",
};

/** What v1.signer returns for a signature made by `PK` (as if PK were the derived key). */
async function mpcSig(tx: TransactionSerializableEIP1559): Promise<MpcSignature> {
  const s = await sign({ hash: keccak256(serializeTransaction(tx)), privateKey: PK });
  return { big_r: { affine_point: `${s.yParity ? "03" : "02"}${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity! };
}

describe("MPC signature -> signed EIP-1559 tx", () => {
  it("assembles a tx that recovers to the derived address", async () => {
    const raw = await assembleSignedTx(unsigned, await mpcSig(unsigned), me);
    expect(raw.startsWith("0x02")).toBe(true);
    expect(mpcToSignature(await mpcSig(unsigned)).r).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("refuses a signature for another tx or another address", async () => {
    await expect(assembleSignedTx({ ...unsigned, nonce: 5 }, await mpcSig(unsigned), me)).rejects.toThrow(/recovers to/);
    await expect(assembleSignedTx(unsigned, await mpcSig(unsigned), "0x0000000000000000000000000000000000000001")).rejects.toThrow();
  });
});

describe("CCTP helpers", () => {
  const json = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

  it("fast max fee = ceil(amount * bps / 10000) * 2 + 1, fractional bps included", async () => {
    // 2 USDC at 1.3 bps = 260 units exactly; 2.000001 USDC rounds up to 261.
    const f = vi.fn(() => json([{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]));
    expect(await cctpFastMaxFee("https://iris", 2_000_000n, f as unknown as typeof fetch)).toBe(260n * 2n + 1n);
    expect(f).toHaveBeenCalledWith("https://iris/v2/burn/USDC/fees/6/15");
    expect(await cctpFastMaxFee("https://iris", 2_000_001n, f as unknown as typeof fetch)).toBe(261n * 2n + 1n);
  });

  it("polls until the message is attested", async () => {
    const replies = [json({}, false), json({ messages: [{ status: "pending_confirmations" }] }), json({ messages: [{ status: "complete", message: "0xaa", attestation: "0xbb" }] })];
    const f = vi.fn(() => replies.shift()!);
    const a = await waitForAttestation("https://iris", "0xburn" as Hex, { intervalMs: 1, fetcher: f as unknown as typeof fetch });
    expect(a).toEqual({ message: "0xaa", attestation: "0xbb" });
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("PolicyClient", () => {
  afterEach(() => vi.unstubAllGlobals());
  const viewReturning = (value: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }) })));

  it("cancels an unfinished plan before committing a new one", async () => {
    viewReturning({ plan_hash: "0x01", usdc_budget: "1", expires_at_ns: Date.now() * 1e6 + 6e11, max_signatures: 5, signatures_used: 2 });
    const calls: string[] = [];
    const sender: NearSender = { accountId: "u.testnet", call: async (m) => (calls.push(m), { txHash: `tx-${m}` }) };
    const c = new PolicyClient("https://rpc", "policy.testnet", "u.testnet", sender);
    expect(await c.commitPlan({ planId: `0x${"11".repeat(32)}`, usdcBudget: 2_000_000n, ttlSeconds: 1800n, maxSignatures: 5 })).toBe("tx-commit_plan");
    expect(calls).toEqual(["cancel_plan", "commit_plan"]);
  });

  it("surfaces an on-chain rejection with its NEAR tx", async () => {
    const sender: NearSender = { accountId: "u.testnet", call: async () => ({ txHash: "abc", error: "recipient 0xabc not in your allowlist" }) };
    const c = new PolicyClient("https://rpc", "policy.testnet", "u.testnet", sender);
    const err = await c.requestSignature("0x00", {} as never).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyRejection);
    expect(err).toMatchObject({ reason: "recipient 0xabc not in your allowlist", nearTx: "abc" });
  });

  it("extracts the policy reason from a NEAR failure", () => {
    const failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: policy: weekly cap exceeded (requested 6000000 > remaining 5000000 USDC base units)" } } } };
    expect(failureReason(failure)).toBe("weekly cap exceeded (requested 6000000 > remaining 5000000 USDC base units)");
  });
});

describe("guardLog", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("lists accepted and rejected policy calls with the rejection reason", async () => {
    const nearblocks = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        txns: [
          { transaction_hash: "A", signer_account_id: "u.testnet", block_timestamp: "1790000000000000000", actions: [{ action: "FUNCTION_CALL", method: "request_signature" }], outcomes: { status: false } },
          { transaction_hash: "B", signer_account_id: "u.testnet", block_timestamp: "1790000001000000000", actions: [{ action: "FUNCTION_CALL", method: "commit_plan" }], outcomes: { status: true } },
        ],
      }),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({ result: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: policy: recipient 0xabc not in your allowlist" } } } } } } }),
    })));
    const { guardLog } = await import("../src/guard");
    const log = await guardLog({ policy: "p.testnet", nearRpc: "https://rpc", fetcher: nearblocks as unknown as typeof fetch });
    expect(log.map((e) => [e.method, e.ok, e.reason])).toEqual([
      ["request_signature", false, "recipient 0xabc not in your allowlist"],
      ["commit_plan", true, undefined],
    ]);
    expect(log[0]!.time).toBe("2026-09-21T14:13:20.000Z");
  });
});
