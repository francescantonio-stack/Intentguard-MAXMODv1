import { describe, expect, it } from "vitest";
import { MONAD_TESTNET } from "../src/chains";
import { miniSwapAmountOut, planHash } from "../src/planHash";
import { VECTOR } from "./fixtures";


describe("planHash", () => {
  it("matches the vector read from the deployed PlanExecutor", () => {
    expect(planHash(VECTOR.plan, MONAD_TESTNET.id, MONAD_TESTNET.planExecutor)).toBe(VECTOR.expected);
  });

  it("changes when any field, the chain or the executor changes", () => {
    const h = planHash(VECTOR.plan, MONAD_TESTNET.id, MONAD_TESTNET.planExecutor);
    expect(planHash({ ...VECTOR.plan, amountIn: 1_000_001n }, MONAD_TESTNET.id, MONAD_TESTNET.planExecutor)).not.toBe(h);
    expect(planHash(VECTOR.plan, 84532, MONAD_TESTNET.planExecutor)).not.toBe(h);
    expect(planHash(VECTOR.plan, MONAD_TESTNET.id, MONAD_TESTNET.miniSwap)).not.toBe(h);
  });
});

describe("miniSwapAmountOut", () => {
  it("applies the 0.30% fee like MiniSwap._getAmountOut", () => {
    // 1 USDC into a 63.67 USDC / 14.15 WMON pool
    const out = miniSwapAmountOut(1_000_000n, 63_670_000n, 14_150_000_000_000_000_000n);
    expect(out).toBe((1_000_000n * 9_970n * 14_150_000_000_000_000_000n) / (63_670_000n * 10_000n + 1_000_000n * 9_970n));
    expect(() => miniSwapAmountOut(1n, 0n, 1n)).toThrow();
  });
});
