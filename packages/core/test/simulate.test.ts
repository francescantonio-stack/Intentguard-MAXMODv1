import { describe, expect, it } from "vitest";
import { maxUint256, encodeFunctionData, encodeErrorResult, type Address, type Hex } from "viem";
import { erc20Abi, planExecutorAbi } from "../src/abi";
import {
  decodeTokenEffects, parseCount, revertReason, simSucceeded, simulateTx, toActionBlocked, toSafeHoldInput, toSuccessOddsInput, checkSimulateApiInput, SIM_DEFAULTS,
  type ProposedTx, type SimClient,
} from "../src/simulate";
import { APPROVAL_SELECTORS } from "../src/approvals";

const FROM = "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B" as Address;
const TO = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address;
const PLAN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const addr = (a: string) => a.toLowerCase();

const tx = (over: Partial<ProposedTx> = {}): ProposedTx => ({ chainId: 10143, from: FROM, to: TO, data: "0x", value: 0n, ...over });

function stub(h: Partial<{ call: unknown; estimateGas: bigint; getBalance: bigint; getGasPrice: bigint; callThrow: unknown; gasThrow: unknown; balanceThrow: unknown; gasPriceThrow: unknown; omitGasPrice: boolean }>): SimClient {
  const client: SimClient = {
    call: async () => { if (h.callThrow) throw h.callThrow; return { data: (h.call as Hex) ?? "0x" }; },
    estimateGas: async () => { if (h.gasThrow) throw h.gasThrow; return h.estimateGas ?? 21_000n; },
    getBalance: async () => { if (h.balanceThrow) throw h.balanceThrow; return h.getBalance ?? 10n ** 18n; },
  };
  if (!h.omitGasPrice) {
    client.getGasPrice = async () => {
      if (h.gasPriceThrow) throw h.gasPriceThrow;
      return h.getGasPrice ?? 1_000_000_000n;
    };
  }
  return client;
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
    expect(u.ok).toBe(false);
    expect(u.blockReason).toBe("UnlimitedApprove");
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

describe("getGasPrice required", () => {
  it("blocks SimUnavailable when getGasPrice is missing or fails (fee not skipped)", async () => {
    const missing = await simulateTx(tx(), stub({ omitGasPrice: true }));
    expect(missing.ok).toBe(false);
    expect(missing.blockReason).toBe("SimUnavailable");
    expect(missing.revert?.reason).toMatch(/getGasPrice/);
    const boom = await simulateTx(tx(), stub({ gasPriceThrow: new Error("gas rpc down") }));
    expect(boom.ok).toBe(false);
    expect(boom.blockReason).toBe("SimUnavailable");
    expect(boom.revert?.reason).toMatch(/eth_gasPrice|gas rpc down/);
  });
});

describe("config limits", () => {
  it("rejects a chainId that does not fit in a safe integer", async () => {
    const r = await simulateTx({ chainId: 2n ** 256n, from: FROM, to: TO, data: "0x", value: 0n }, stub({}));
    expect(r.ok).toBe(false);
    expect(r.revert?.reason).toMatch(/chainId/);
  });


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
    expect(r.ok).toBe(false);
    expect(r.blockReason).toBe("UnlimitedApprove");
    expect(r.warnings.some((w) => w.code === "UNLIMITED_APPROVE")).toBe(true);
  });
});


const incAbi = [{ type: "function", name: "increaseAllowance", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "addedValue", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const permit2612Abi = [{ type: "function", name: "permit", stateMutability: "nonpayable", inputs: [
  { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
], outputs: [] }] as const;
const permitDaiAbi = [{ type: "function", name: "permit", stateMutability: "nonpayable", inputs: [
  { name: "holder", type: "address" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" },
  { name: "expiry", type: "uint256" }, { name: "allowed", type: "bool" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" },
], outputs: [] }] as const;
const setAllAbi = [{ type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [
  { name: "operator", type: "address" }, { name: "approved", type: "bool" },
], outputs: [] }] as const;
const Z32 = ("0x" + "11".repeat(32)) as Hex;

describe("approval variants are blocked when unlimited or malformed", () => {
  it("blocks increaseAllowance(max), EIP-2612 permit(max), DAI permit(allowed=true) and setApprovalForAll(true)", async () => {
    const cases: Array<[string, Hex]> = [
      ["increaseAllowance", encodeFunctionData({ abi: incAbi, functionName: "increaseAllowance", args: [TO, maxUint256] })],
      ["permit2612", encodeFunctionData({ abi: permit2612Abi, functionName: "permit", args: [FROM, TO, maxUint256, 1n, 27, Z32, Z32] })],
      ["permitDAI", encodeFunctionData({ abi: permitDaiAbi, functionName: "permit", args: [FROM, TO, 0n, 1n, true, 27, Z32, Z32] })],
      ["setApprovalForAll", encodeFunctionData({ abi: setAllAbi, functionName: "setApprovalForAll", args: [TO, true] })],
    ];
    for (const [name, data] of cases) {
      const { warnings, effects } = decodeTokenEffects(tx({ to: TOKEN, data }));
      expect(warnings.some((w) => w.code === "UNLIMITED_APPROVE"), name).toBe(true);
      expect(effects[0]?.kind, name).toBe("approve");
      const r = await simulateTx(tx({ to: TOKEN, data }), stub({}));
      expect(r.ok, name).toBe(false);
      expect(r.blockReason, name).toBe("UnlimitedApprove");
      expect(toActionBlocked(r, PLAN)?.reason, name).toBe("UnlimitedApprove");
    }
  });

  it("does not flag a finite increaseAllowance, a finite permit, DAI allowed=false or setApprovalForAll(false)", async () => {
    const finite = [
      encodeFunctionData({ abi: incAbi, functionName: "increaseAllowance", args: [TO, 10n] }),
      encodeFunctionData({ abi: permit2612Abi, functionName: "permit", args: [FROM, TO, 10n, 1n, 27, Z32, Z32] }),
      encodeFunctionData({ abi: permitDaiAbi, functionName: "permit", args: [FROM, TO, 0n, 1n, false, 27, Z32, Z32] }),
      encodeFunctionData({ abi: setAllAbi, functionName: "setApprovalForAll", args: [TO, false] }),
    ];
    for (const data of finite) {
      const { warnings } = decodeTokenEffects(tx({ to: TOKEN, data }));
      expect(warnings.some((w) => w.code === "UNLIMITED_APPROVE")).toBe(false);
      const r = await simulateTx(tx({ to: TOKEN, data }), stub({}));
      expect(r.ok).toBe(true);
    }
  });

  it("blocks truncated or malformed calldata with an approval selector", async () => {
    expect(APPROVAL_SELECTORS.size).toBe(5); // approve, increaseAllowance, 2 permits, setApprovalForAll
    for (const sel of APPROVAL_SELECTORS) {
      const truncated = (sel + "00") as Hex; // selector + 1 byte, not enough args
      const { warnings } = decodeTokenEffects(tx({ to: TOKEN, data: truncated }));
      expect(warnings[0]?.code, sel).toBe("MALFORMED_APPROVAL");
      const r = await simulateTx(tx({ to: TOKEN, data: truncated }), stub({}));
      expect(r.ok, sel).toBe(false);
      expect(r.blockReason, sel).toBe("MalformedApproval");
      expect(toActionBlocked(r, PLAN)?.reason, sel).toBe("MalformedApproval");
    }
  });
});

describe("RPC errors, balance and planId", () => {
  it("marks an RPC timeout or HTTP error as SimUnavailable, not SimRevert", async () => {
    const timeout = await simulateTx(tx(), stub({ callThrow: { name: "TimeoutError", message: "request timed out" } }));
    expect(timeout.ok).toBe(false);
    expect(timeout.blockReason).toBe("SimUnavailable");
    expect(toActionBlocked(timeout, PLAN)?.reason).toBe("SimUnavailable");
    const http = await simulateTx(tx(), stub({ callThrow: { name: "HttpRequestError", message: "HTTP 503" } }));
    expect(toActionBlocked(http, PLAN)?.reason).toBe("SimUnavailable");
    const reverted = await simulateTx(tx(), stub({ callThrow: { message: "execution reverted: cap" } }));
    expect(toActionBlocked(reverted, PLAN)?.reason).toBe("SimRevert");
  });

  it("blocks when getBalance fails, or when the balance is below value+fee", async () => {
    const fail = await simulateTx(tx({ value: 1n }), stub({ balanceThrow: new Error("rpc down") }));
    expect(fail.ok).toBe(false);
    expect(fail.blockReason).toBe("SimUnavailable");
    expect(toActionBlocked(fail, PLAN)?.reason).toBe("SimUnavailable");
    const short = await simulateTx(tx({ value: 100n }), stub({ estimateGas: 10n, getGasPrice: 2n, getBalance: 100n }));
    // needed = 100 + 20 = 120 > 100
    expect(short.ok).toBe(false);
    expect(short.blockReason).toBe("InsufficientBalance");
    expect(toActionBlocked(short, PLAN)?.reason).toBe("InsufficientBalance");
  });

  it("does not hide a failed simulation when planId is missing: event is MissingPlanId", async () => {
    const r = await simulateTx(tx(), stub({ callThrow: { message: "execution reverted" } }));
    expect(toActionBlocked(r, undefined)?.reason).toBe("MissingPlanId");
    expect(toActionBlocked(r, "0xzz")?.reason).toBe("MissingPlanId");
    expect(toActionBlocked(r, PLAN)?.reason).toBe("SimRevert");
    const ok = await simulateTx(tx(), stub({}));
    expect(toActionBlocked(ok, undefined)).toBeNull();
  });
});

describe("checkSimulateApiInput", () => {
  const base = { chainId: 10143, from: FROM, to: TO };
  it("rejects data that is not valid 0x hex and invalid value (parseCount)", () => {
    const badData = checkSimulateApiInput({ ...base, data: "ffff" });
    expect(badData.ok).toBe(false);
    if (!badData.ok) {
      expect(badData.error).toMatch(/hex/);
      expect(badData.status).toBe(400);
    }
    expect(checkSimulateApiInput({ ...base, data: "0xzz" }).ok).toBe(false);
    const badVal = checkSimulateApiInput({ ...base, value: "abc" });
    expect(badVal.ok).toBe(false);
    if (!badVal.ok) expect(badVal.status).toBe(400);
    const ok = checkSimulateApiInput({ ...base, data: "0x", value: "10", planId: PLAN });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.tx.value).toBe(10n);
      expect(ok.planIdMissing).toBe(false);
    }
    const noPlan = checkSimulateApiInput({ ...base });
    expect(noPlan.ok).toBe(true);
    if (noPlan.ok) expect(noPlan.planIdMissing).toBe(true);
    expect(checkSimulateApiInput({ ...base, planId: "0x12" }).ok).toBe(false);
  });
});
