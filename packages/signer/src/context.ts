import { erc20Abi, MONAD_TESTNET, BASE_SEPOLIA, miniSwapAbi, planExecutorAbi, type PlanContext } from "@intentguard/core";
import type { Address } from "viem";
import type { IntentGuardConfig } from "./config";
import { publicClient } from "./evm";
import type { PolicyClient, UserView } from "./near";

export type ChainState = {
  account: Address;
  near: UserView | null;
  executor: { registered: boolean; nonce: bigint; remaining: bigint };
  reserves: { usdc: bigint; wmon: bigint };
  balances: { baseUsdc: bigint; baseEth: bigint; monadUsdc: bigint; monadMon: bigint };
};

/** Everything the planner and the UI need, read in parallel from NEAR, Monad and Base Sepolia. */
export async function readState(cfg: Pick<IntentGuardConfig, "monadRpc" | "baseRpc">, policy: PolicyClient, account: Address): Promise<ChainState> {
  const monad = publicClient("monad-testnet", cfg);
  const base = publicClient("base-sepolia", cfg);
  const ex = { address: MONAD_TESTNET.planExecutor, abi: planExecutorAbi } as const;
  const [near, nonce, remaining, passkey, reserves, token0, baseUsdc, baseEth, monadUsdc, monadMon] = await Promise.all([
    policy.getUser(),
    monad.readContract({ ...ex, functionName: "nonces", args: [account] }),
    monad.readContract({ ...ex, functionName: "remainingThisPeriod", args: [account] }),
    monad.readContract({ ...ex, functionName: "passkeys", args: [account] }),
    monad.readContract({ address: MONAD_TESTNET.miniSwap, abi: miniSwapAbi, functionName: "getReserves" }),
    monad.readContract({ address: MONAD_TESTNET.miniSwap, abi: miniSwapAbi, functionName: "token0" }),
    base.readContract({ address: BASE_SEPOLIA.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    base.getBalance({ address: account }),
    monad.readContract({ address: MONAD_TESTNET.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    monad.getBalance({ address: account }),
  ]);
  const usdcIs0 = token0.toLowerCase() === MONAD_TESTNET.usdc.toLowerCase();
  return {
    account,
    near,
    executor: { registered: BigInt(passkey[0]) !== 0n || BigInt(passkey[1]) !== 0n, nonce, remaining },
    reserves: { usdc: usdcIs0 ? reserves[0] : reserves[1], wmon: usdcIs0 ? reserves[1] : reserves[0] },
    balances: { baseUsdc, baseEth, monadUsdc, monadMon },
  };
}

/** Planner input from on-chain state: the tighter of the NEAR and Monad weekly allowances applies. */
export function planContext(s: ChainState, o: { now?: bigint; cctpMaxFee?: bigint } = {}): PlanContext {
  const nearRemaining = s.near ? BigInt(s.near.remaining) : 0n;
  return {
    account: s.account,
    nonce: s.executor.nonce,
    now: o.now ?? BigInt(Math.floor(Date.now() / 1000)),
    reserves: s.reserves,
    weeklyRemaining: nearRemaining < s.executor.remaining ? nearRemaining : s.executor.remaining,
    cctpMaxFee: o.cctpMaxFee,
    allowedRecipients: (s.near?.recipients ?? []) as Address[],
  };
}

