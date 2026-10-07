import { describe, expect, it } from "vitest";
import { decodeFunctionData, pad } from "viem";
import { cctpAbi, erc20Abi } from "../src/abi";
import { BASE_SEPOLIA, CCTP, MONAD_TESTNET } from "../src/chains";
import { parseRules } from "../src/parser";
import { miniSwapAmountOut, planHash } from "../src/planHash";
import { buildPlan, PolicyError, type PlanContext } from "../src/planner";

const DEMO = "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana.";
const ACCOUNT = "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B";
const ctx: PlanContext = {
  account: ACCOUNT,
  nonce: 3n,
  now: 1_790_000_000n,
  reserves: { usdc: 63_670_000n, wmon: 14_150_000_000_000_000_000n },
};
const plan = (text: string, extra: Partial<PlanContext> = {}) => buildPlan(parseRules(text), { ...ctx, ...extra });
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof PolicyError) return e.code; throw e; }
  return "ok";
};

describe("buildPlan", () => {
  it("demo command -> CCTP burn/mint, then one passkey-approved swap + deposit", () => {
    const p = plan(DEMO, { cctpMaxFee: 1_000n });
    expect(p.steps.map((s) => `${s.chain}:${s.kind}`)).toEqual([
      "base-sepolia:approve", "base-sepolia:cctp-burn", "monad-testnet:cctp-receive", "monad-testnet:approve", "monad-testnet:execute",
    ]);

    const burn = decodeFunctionData({ abi: cctpAbi, data: p.steps[1]!.data! });
    expect(burn.args).toEqual([2_000_000n, 15, pad(ACCOUNT.toLowerCase() as `0x${string}`), BASE_SEPOLIA.usdc, pad("0x0"), 1_000n, CCTP.fastFinality]);

    const amountIn = 2_000_000n - 1_000n;
    const swapAmount = amountIn / 2n;
    expect(p.executorPlan).toEqual({
      account: ACCOUNT,
      amountIn,
      swapAmount,
      minAmountOut: (miniSwapAmountOut(swapAmount, ctx.reserves!.usdc, ctx.reserves!.wmon) * 9_900n) / 10_000n,
      unwrap: true,
      nonce: 3n,
      deadline: 1_790_001_800n,
    });
    expect(p.planId).toBe(planHash(p.executorPlan!, MONAD_TESTNET.id, MONAD_TESTNET.planExecutor));
    expect(p.commit).toEqual({ usdcBudget: 2_000_000n, ttlSeconds: 1800n, maxSignatures: 5 });
    expect(p.weeklyCap).toBe(5_000_000n);
    expect(decodeFunctionData({ abi: erc20Abi, data: p.steps[3]!.data! }).args).toEqual([MONAD_TESTNET.planExecutor, amountIn]);
  });

  it("standard CCTP transfer when no fee is given", () => {
    const burn = decodeFunctionData({ abi: cctpAbi, data: plan(DEMO).steps[1]!.data! });
    expect(burn.args.slice(5)).toEqual([0n, CCTP.standardFinality]);
  });

  it("explicit swap + deposit spend from the Monad balance", () => {
    const p = plan("Swap 0.5 USDC to MON and deposit 0.5 USDC into the vault");
    expect(p.executorPlan).toMatchObject({ amountIn: 1_000_000n, swapAmount: 500_000n });
    expect(p.commit.usdcBudget).toBe(1_000_000n);
  });

  it("deposit only needs no pool quote", () => {
    const p = plan("Metti 1,5 USDC nel vault", { reserves: undefined });
    expect(p.executorPlan).toMatchObject({ amountIn: 1_500_000n, swapAmount: 0n, minAmountOut: 0n });
  });

  it("transfer to an allowlisted recipient", () => {
    const to = "0xD22418AF35295B515F00eBfcFE8a42bBeF446300";
    const p = plan(`Send 1 USDC to ${to} on Base`, { allowedRecipients: [to] });
    expect(p.executorPlan).toBeUndefined();
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ chain: "base-sepolia", chainId: 84532, kind: "transfer", to: BASE_SEPOLIA.usdc });
    expect(p.planId).toBe(plan(`Send 1 USDC to ${to} on Base`, { allowedRecipients: [to] }).planId); // deterministic
  });

  it.each([
    ["negative demo: stranger recipient", "Manda 50 USDC a 0xabc…", {}, "RecipientNotAllowed"],
    ["valid address, not allowlisted", "Send 1 USDC to 0xD22418AF35295B515F00eBfcFE8a42bBeF446300", {}, "RecipientNotAllowed"],
    ["over the weekly cap in the command", "Porta 10 USDC da Base su Monad e metti tutto nel vault. Max 5 USDC a settimana", {}, "OverWeeklyCap"],
    ["over the allowance left on-chain (2nd plan in the week)", DEMO, { weeklyRemaining: 1_500_000n }, "OverWeeklyCap"],
    ["over PlanExecutor.maxPlanAmount", "Metti 150 USDC nel vault", {}, "OverPlanLimit"],
    ["swap without pool reserves", "Cambia 1 USDC in MON", { reserves: undefined }, "InvalidPlan"],
    ["bridge smaller than the CCTP fee", "Bridge 0.001 USDC from Base to Monad", { cctpMaxFee: 1_000n }, "InvalidPlan"],
    ["CCTP fee above the policy's 0.5% ceiling", "Bridge 2 USDC from Base to Monad", { cctpMaxFee: 10_001n }, "InvalidPlan"],
    ["deposit more than was bridged", "Porta 1 USDC da Base su Monad e metti 2 USDC nel vault", {}, "InvalidPlan"],
  ] as const)("rejects: %s", (_name, text, extra, expected) => {
    expect(code(() => plan(text, extra))).toBe(expected);
  });

  it("accepts a plan exactly at the allowance left", () => {
    expect(code(() => plan(DEMO, { weeklyRemaining: 2_000_000n }))).toBe("ok");
  });
});
