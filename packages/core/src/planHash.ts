import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from "viem";

/** Mirrors PlanExecutor.Plan (contracts/evm/src/PlanExecutor.sol). */
export type ExecutorPlan = {
  account: Address;
  amountIn: bigint;
  swapAmount: bigint;
  minAmountOut: bigint;
  unwrap: boolean;
  nonce: bigint;
  deadline: bigint;
};

export const PLAN_TYPEHASH = keccak256(
  new TextEncoder().encode(
    "Plan(address account,uint256 amountIn,uint256 swapAmount,uint256 minAmountOut,bool unwrap,uint256 nonce,uint256 deadline)",
  ),
);

/** Off-chain twin of PlanExecutor.planHash: the 32-byte WebAuthn challenge the passkey signs. */
export function planHash(plan: ExecutorPlan, chainId: number, executor: Address): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" },
        { type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" },
      ],
      [PLAN_TYPEHASH, plan.account, plan.amountIn, plan.swapAmount, plan.minAmountOut, plan.unwrap, plan.nonce, plan.deadline],
    ),
  );
  return keccak256(encodePacked(["bytes2", "uint256", "address", "bytes32"], ["0x1901", BigInt(chainId), executor, structHash]));
}

/** MiniSwap._getAmountOut (0.30% fee), for quoting from on-chain reserves without an extra call. */
export function miniSwapAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (reserveIn === 0n || reserveOut === 0n) throw new Error("MiniSwap: insufficient liquidity");
  const withFee = amountIn * 9_970n;
  return (withFee * reserveOut) / (reserveIn * 10_000n + withFee);
}
