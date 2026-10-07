import { describe, expect, it } from "vitest";
import { createPublicClient, http, parseAbi } from "viem";
import { MONAD_TESTNET } from "../src/chains";
import { planHash } from "../src/planHash";
import { VECTOR } from "./fixtures";

// Read-only check against the deployed PlanExecutor. Run with: LIVE=1 pnpm test
describe.skipIf(!process.env.LIVE)("planHash (live, Monad testnet)", () => {
  it("matches PlanExecutor.planHash on-chain", async () => {
    const client = createPublicClient({ transport: http(MONAD_TESTNET.rpc) });
    const onchain = await client.readContract({
      address: MONAD_TESTNET.planExecutor,
      abi: parseAbi([
        "function planHash((address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline) plan) view returns (bytes32)",
      ]),
      functionName: "planHash",
      args: [VECTOR.plan],
    });
    expect(planHash(VECTOR.plan, MONAD_TESTNET.id, MONAD_TESTNET.planExecutor)).toBe(onchain);
    console.log("on-chain planHash:", onchain);
  });
});
