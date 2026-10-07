import type { ExecutorPlan } from "../src/planHash";

export const VECTOR = {
  plan: {
    account: "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B",
    amountIn: 1_000_000n,
    swapAmount: 500_000n,
    minAmountOut: 123_456_789n,
    unwrap: true,
    nonce: 7n,
    deadline: 1_800_000_000n,
  } satisfies ExecutorPlan,
  // Pinned in contracts/evm/test/PlanHashVector.t.sol (Solidity side) and planHash.live.test.ts (deployed contract).
  expected: "0x5e684f0da345231ea31b267600824e68a2b06e4a489ec4a574643e7ab4c65147",
};
