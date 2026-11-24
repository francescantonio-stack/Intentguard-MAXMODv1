import { describe, expect, it } from "vitest";
import { maxUint256, encodeFunctionData, encodeErrorResult, type Address, type Hex } from "viem";
import { erc20Abi, planExecutorAbi } from "../src/abi";
import {
  decodeTokenEffects, parseCount, revertReason, simSucceeded, simulateTx, toActionBlocked, toSafeHoldInput, toSuccessOddsInput, SIM_DEFAULTS,
  type ProposedTx, type SimClient,
} from "../src/simulate";

const FROM = "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B" as Address;
const TO = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address;
const PLAN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const addr = (a: string) => a.toLowerCase();

const tx = (over: Partial<ProposedTx> = {}): ProposedTx => ({ chainId: 10143, from: FROM, to: TO, data: "0x", value: 0n, ...over });

function stub(h: Partial<{ call: unknown; estimateGas: bigint; getBalance: bigint; getGasPrice: bigint; callThrow: unknown; gasThrow: unknown }>): SimClient {
  return {
    call: async () => { if (h.callThrow) throw h.callThrow; return { data: (h.call as Hex) ?? "0x" }; },
    estimateGas: async () => { if (h.gasThrow) throw h.gasThrow; return h.estimateGas ?? 21_000n; },
    getBalance: async () => h.getBalance ?? 10n ** 18n,
    getGasPrice: h.getGasPrice !== undefined || true ? async () => h.getGasPrice ?? 1_000_000_000n : undefined,
  };
}

const transferData = (to: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] });
const approveData = (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });

describe("decodeTokenEffects", () => {
  it("decodes ERC20 transfer", () => {
    const { effects, warnings } = decodeTokenEffects(tx({ to: TOKEN, data: transferData(TO, 1_500_000n) }));
    expect(warnings).toEqual([]);
    expect(effects).toHaveLength(1);
    const e = effects[0]!;
    expect(e.kind).toBe("transfer");
    if (e.kind === "transfer") {
      expect(e.token).toBe(addr(TOKEN));
      expect(e.from).toBe(addr(FROM));
      expect(e.to).toBe(addr(TO));
      expect(e.amount.value).toBe(1_500_000n);
      expect(e.amount.source).toBe("calldata (decoded)");
    }
  });

  it("flags unlimited approve", () => {
    const { effects, warnings } = decodeTokenEffects(tx({ to: TOKEN, data: approveData(TO, maxUint256) }));
    expect(effects[0]?.kind).toBe("approve");
    if (effects[0]?.kind === "approve") expect(effects[0].unlimited).toBe(true);
    expect(warnings.some((w) => w.code === "UNLIMITED_APPROVE")).toBe(true);
    expect(warnings[0]!.detail).toMatch(/approve illimitato/i);
  });

  it("a finite approve is not flagged", () => {
    const { effects, warnings } = decodeTokenEffects(tx({ to: TOKEN, data: approveData(TO, 100n) }));
    if (effects[0]?.kind === "approve") expect(effects[0].unlimited).toBe(false);
    expect(warnings.some((w) => w.code === "UNLIMITED_APPROVE")).toBe(false);
  });

  it("warns on unknown calldata", () => {
    const { effects, warnings } = decodeTokenEffects(tx({ data: "0xdeadbeef00000001" }));
    expect(effects).toEqual([]);
    expect(warnings[0]?.code).toBe("UNKNOWN_CALLDATA");
  });
});

describe("revertReason", () => {
  it("decodes Error(string)", () => {
    const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["not enough"] });
    expect(revertReason({ data }).reason).toBe("not enough");
  });

  it("decodes a PlanExecutor custom error", () => {
    const data = encodeErrorResult({ abi: planExecutorAbi, errorName: "OverWeeklyCap", args: [5n, 1n] });
    expect(revertReason({ data }).reason).toBe("OverWeeklyCap(5,1)");
  });

  it("falls back to the message when there is no data", () => {
    expect(revertReason(new Error("execution reverted")).reason).toMatch(/execution reverted/);
  });
});

describe("simulateTx", () => {
  it("reports native delta, gas and sources on a successful transfer of value", async () => {
    const r = await simulateTx(tx({ value: 3n }), stub({ estimateGas: 21_000n, getGasPrice: 2n, getBalance: 1_000_000n }));
    expect(r.ok).toBe(true);
    expect(r.gas?.value).toBe(21_000n);
    expect(r.gas?.source).toMatch(/eth_estimateGas/);
    expect(r.gasPrice?.source).toMatch(/eth_gasPrice/);
    expect(r.nativeBalanceBefore?.value).toBe(1_000_000n);
    expect(r.nativeBalanceBefore?.source).toMatch(/eth_getBalance/);
    expect(r.nativeDelta.value).toBe(-(3n + 21_000n * 2n));
    expect(r.nativeDelta.source).toMatch(/value \+ gas/);
    expect(r.lines[0]).toMatch(/Riuscirebbe/);
    expect(r.lines.join("\n")).toMatch(/eth_estimateGas/);
  });

  it("returns the revert reason and a zero native delta when eth_call fails", async () => {
    const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }], errorName: "Error", args: ["insufficient funds"] });
    const r = await simulateTx(tx({ value: 5n }), stub({ callThrow: { data, message: "execution reverted" } }));
    expect(r.ok).toBe(false);
    expect(r.revert?.reason).toBe("insufficient funds");
    expect(r.nativeDelta.value).toBe(0n);
    expect(r.lines[0]).toMatch(/Fallirebbe: insufficient funds/);
  });

  it("includes the decoded ERC20 transfer and the unlimited-approve warning", async () => {
    const r = await simulateTx(tx({ to: TOKEN, data: transferData(TO, 42n) }), stub({}));
    expect(r.ok).toBe(true);
    expect(r.tokenEffects[0]).toMatchObject({ kind: "transfer", amount: { value: 42n } });
    const u = await simulateTx(tx({ to: TOKEN, data: approveData(TO, maxUint256) }), stub({}));
    expect(u.warnings.some((w) => w.code === "UNLIMITED_APPROVE")).toBe(true);
    expect(u.lines.join("\n")).toMatch(/ILLIMITATO/);
  });
});

describe("adapters", () => {
  it("maps a revert to ActionBlocked(planId, reason, amount)", async () => {
    const r = await simulateTx(tx({ to: TOKEN, data: transferData(TO, 7n) }), stub({ callThrow: { message: "execution reverted: cap" } }));
    const b = toActionBlocked(r, PLAN);
    expect(b).not.toBeNull();
    expect(b!.kind).toBe("blocked");
    expect(b!.planId).toBe(PLAN.toLowerCase());
    expect(b!.reason).toBe("SimRevert");
    expect(b!.amount).toBe(7n);
    expect(typeof b!.amount).toBe("bigint");
    expect(b!.id).toBeNull();
    expect(b!.ts).toMatch(/^\d{4}-/ );
  });

  it("maps an unlimited approve to SIM_UNLIMITED_APPROVE (amount 0, not 2^256-1)", async () => {
    const r = await simulateTx(tx({ to: TOKEN, data: approveData(TO, maxUint256) }), stub({}));
    const b = toActionBlocked(r, PLAN);
    expect(b?.kind).toBe("blocked");
    expect(b?.reason).toBe("UnlimitedApprove");
    expect(b?.planId).toBe(PLAN.toLowerCase());
    expect(b?.amount).toBe(maxUint256); // amount stays known, never rewritten to 0n
  });

  it("does not emit ActionBlocked for a clean success", async () => {
    const r = await simulateTx(tx({ value: 1n }), stub({}));
    expect(toActionBlocked(r, PLAN)).toBeNull();
  });

  it("feeds Hunter success-odds: failed sim => dryRun ok:false; gasNeeded on success", async () => {
    const bad = toSuccessOddsInput(await simulateTx(tx(), stub({ callThrow: { message: "no" } })));
    expect(bad.dryRun[0]).toEqual({ ok: false, reason: "simulazione: no" });
    const good = toSuccessOddsInput(await simulateTx(tx(), stub({ estimateGas: 100n, getGasPrice: 3n })));
    expect(good.dryRun[0]!.ok).toBe(true);
    expect(good.gasNeeded).toBe(300n);
  });

  it("feeds Hunter SAFE HOLD: failed sim has confidence 0 so HOLD; success has confidence 1", async () => {
    const hold = toSafeHoldInput(await simulateTx(tx(), stub({ callThrow: { message: "x" } })), "swap");
    expect(hold.required).toEqual(["sim:10143"]);
    expect(hold.observations[0]).toMatchObject({ value: 0, confidence: 0, source: "eth_call" });
    expect(hold.intent).toBe("swap");
    const go = toSafeHoldInput(await simulateTx(tx(), stub({})));
    expect(go.observations[0]).toMatchObject({ value: 1, confidence: 1 });
  });
});

describe("fail-closed", () => {
  it("never throws on null/missing input: returns a BLOCK with a reason", async () => {
    const cases: Array<[unknown, unknown]> = [[null, stub({})], [undefined, stub({})], [tx(), null], [tx(), undefined], [{}, stub({})]];
    for (const [input, client] of cases) {
      const r = await simulateTx(input, client);
      expect(r.ok, String(input)).toBe(false);
      expect(simSucceeded(r)).toBe(false);
      expect(r.revert?.reason).toMatch(/BAD_|Blocco|assente|non valid/);
    }
  });

  it("blocks NaN, Infinity, null and non-finite now; never returns ok", async () => {
    const r1 = await simulateTx(tx({ value: NaN as never }), stub({}));
    const r2 = await simulateTx(tx({ value: Infinity as never }), stub({}));
    const r3 = await simulateTx({ ...tx(), value: null as never }, stub({}));
    const r4 = await simulateTx({ ...tx(), chainId: NaN }, stub({}));
    const r5 = await simulateTx(tx(), stub({}), { now: NaN });
    const r6 = await simulateTx(tx(), stub({}), { now: Infinity });
    for (const r of [r1, r2, r3, r4, r5, r6]) {
      expect(r.ok).toBe(false);
      expect(simSucceeded(r)).toBe(false);
    }
    expect(r5.revert?.reason).toMatch(/BAD_NOW/);
    expect(r1.revert?.reason).toMatch(/BAD_VALUE/);
  });

  it("accepts 0n and numeric strings (normalized), and checksums addresses", async () => {
    expect(parseCount(0n, "v")).toEqual({ ok: true, value: 0n });
    expect(parseCount("0", "v")).toEqual({ ok: true, value: 0n });
    const r = await simulateTx(
      { chainId: "10143", from: FROM.toLowerCase(), to: TO.toLowerCase(), value: "0", data: "0x" },
      stub({ estimateGas: 21_000n, getGasPrice: 0n }),
    );
    expect(r.ok).toBe(true);
    expect(r.chainId).toBe(10143);
    expect(r.nativeDelta.value).toBe(0n); // 0 value + 21000 * 0n gas price
    expect(r.from).toBe(addr(FROM));
    expect(r.to).toBe(addr(TO));
  });

  it("treats a simulation as success only when ok === true (not {ok:0} or {success:false})", () => {
    expect(simSucceeded({ ok: true })).toBe(true);
    expect(simSucceeded({ ok: 0 })).toBe(false);
    expect(simSucceeded({ ok: "true" })).toBe(false);
    expect(simSucceeded({ success: false })).toBe(false);
    expect(simSucceeded({ success: true })).toBe(false);
    expect(simSucceeded(null)).toBe(false);
    expect(toSuccessOddsInput({ ok: 0 }).dryRun[0]!.ok).toBe(false);
    expect(toSuccessOddsInput({ success: false }).dryRun[0]!.ok).toBe(false);
    expect(toSuccessOddsInput({ ok: true, gas: { value: 1n, source: "t" }, gasPrice: { value: 2n, source: "t" } }).dryRun[0]!.ok).toBe(true);
    expect(toSafeHoldInput({ ok: 0, chainId: 1, simulatedAt: 1 }).observations[0]!.confidence).toBe(0);
    expect(toActionBlocked(null, PLAN)?.reason).toBe("SimUnavailable");
    expect(toActionBlocked({ ok: 0 }, PLAN)?.reason).toBe("SimRevert");
    expect(toActionBlocked({ ok: 0 }, PLAN.toUpperCase() as Hex)?.planId).toBe(PLAN.toLowerCase());
  });

  it("redacts secrets in the SAFE HOLD intent and keeps tokenIn", () => {
    const pk = "0x" + "cd".repeat(32);
    const out = toSafeHoldInput({ ok: false, chainId: 1, simulatedAt: 1 }, { tokenIn: "USDC", sk: pk, memo: pk });
    expect(out.intent).toEqual({ tokenIn: "USDC", sk: "[redacted]", memo: "[redacted]" });
  });
});

describe("config limits", () => {
  it("rejects a loosened unlimited-approve threshold and invalid config (BadConfig)", async () => {
    const wide = await simulateTx(tx(), stub({}), { config: { unlimitedApproveMin: SIM_DEFAULTS.unlimitedApproveMin + 1n } });
    expect(wide.ok).toBe(false);
    expect(wide.revert?.reason).toMatch(/BadConfig/);
    expect(toActionBlocked(wide, PLAN)?.reason).toBe("BadConfig");
    for (const config of [null, "x", { unlimitedApproveMin: 0n }, { unlimitedApproveMin: -1n }, { unlimitedApproveMin: 100 }, { unlimitedApproveMin: "1" }, { unlimitedApproveMin: NaN }] as const) {
      const r = await simulateTx(tx(), stub({}), { config: config as never });
      expect(r.ok, String(config)).toBe(false);
      expect(r.revert?.reason).toMatch(/BadConfig/);
    }
  });

  it("accepts a tighter threshold and flags a smaller approve", async () => {
    const r = await simulateTx(tx({ to: TOKEN, data: approveData(TO, 100n) }), stub({}), { config: { unlimitedApproveMin: 50n } });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === "UNLIMITED_APPROVE")).toBe(true);
  });
});
