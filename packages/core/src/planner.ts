import { encodeAbiParameters, encodeFunctionData, getAddress, isAddress, keccak256, pad, type Address, type Hex } from "viem";
import { cctpAbi, erc20Abi } from "./abi";
import { toUnits } from "./amounts";
import { fractionToBps } from "./amounts";
import { BASE_SEPOLIA, CCTP, EXECUTOR_LIMITS, MONAD_TESTNET, type ChainName } from "./chains";
import { miniSwapAmountOut, planHash, type ExecutorPlan } from "./planHash";
import type { Intent } from "./schema";

export class PolicyError extends Error {
  constructor(
    public readonly code: "OverWeeklyCap" | "OverPlanLimit" | "RecipientNotAllowed" | "InvalidPlan",
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export type PlanContext = {
  /** The user's Chain-Signatures-derived EVM address (identical on Base Sepolia and Monad). */
  account: Address;
  /** PlanExecutor.nonces(account). */
  nonce: bigint;
  /** Unix seconds. Passed in so planning stays deterministic. */
  now: bigint;
  /** MiniSwap reserves, needed to bound slippage when the plan swaps. */
  reserves?: { usdc: bigint; wmon: bigint };
  /** min(NEAR policy remaining, PlanExecutor.remainingThisPeriod), if known. */
  weeklyRemaining?: bigint;
  /** CCTP fast-transfer max fee in USDC units; 0 = standard transfer. */
  cctpMaxFee?: bigint;
  slippageBps?: bigint;
  ttlSeconds?: bigint;
  /** Recipients the user allowlisted on the NEAR policy (the account itself is always allowed). */
  allowedRecipients?: Address[];
};

export type StepKind = "approve" | "cctp-burn" | "cctp-receive" | "execute" | "transfer";

/** One signature through the NEAR policy. `data` is absent when it is only known at run time. */
export type Step = {
  chain: ChainName;
  chainId: number;
  kind: StepKind;
  to: Address;
  data?: Hex;
  value?: bigint;
  label: string;
};

export type Plan = {
  intent: Intent;
  steps: Step[];
  /** PlanExecutor.Plan, present when the plan swaps and/or deposits on Monad. */
  executorPlan?: ExecutorPlan;
  /** Commitment for NEAR commit_plan and, with an executorPlan, the passkey challenge (= PlanExecutor.planHash). */
  planId: Hex;
  /** NEAR commit_plan arguments. */
  commit: { usdcBudget: bigint; ttlSeconds: bigint; maxSignatures: number };
  weeklyCap?: bigint;
};

const step = (chain: ChainName, kind: StepKind, to: Address, label: string, data?: Hex, value?: bigint): Step => ({
  chain,
  chainId: chain === "monad-testnet" ? MONAD_TESTNET.id : BASE_SEPOLIA.id,
  kind,
  to,
  label,
  ...(data && { data }),
  ...(value !== undefined && { value }),
});

/** Deterministic planner: no LLM, bigint only. Rejects locally what the chains would reject anyway. */
export function buildPlan(intent: Intent, ctx: PlanContext): Plan {
  const account = getAddress(ctx.account);
  const maxFee = ctx.cctpMaxFee ?? 0n;
  const slippageBps = ctx.slippageBps ?? 100n;
  const ttlSeconds = ctx.ttlSeconds ?? 1800n;
  const allowed = new Set([account, ...(ctx.allowedRecipients ?? []).map((a) => getAddress(a))]);

  const steps: Step[] = [];
  let budget = 0n; // USDC this plan may spend (weekly cap accounting)
  let available: bigint | undefined; // USDC produced by the previous action on Monad
  let swapTotal = 0n;
  let depositTotal = 0n;

  const take = (amount: bigint, what: string) => {
    if (amount === 0n) throw new PolicyError("InvalidPlan", `${what}: amount is zero`);
    if (available === undefined) {
      budget += amount; // spends USDC already on Monad
      return;
    }
    if (amount > available) throw new PolicyError("InvalidPlan", `${what}: ${amount} > ${available} available`);
    available -= amount;
  };

  for (const a of intent.actions) {
    switch (a.type) {
      case "bridge": {
        const amount = toUnits(a.amount, "USDC");
        if (amount <= maxFee) throw new PolicyError("InvalidPlan", "bridge amount does not cover the CCTP fee");
        budget += amount;
        steps.push(
          step("base-sepolia", "approve", BASE_SEPOLIA.usdc, `Approve ${a.amount} USDC to CCTP`,
            encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CCTP.tokenMessenger, amount] })),
          step("base-sepolia", "cctp-burn", CCTP.tokenMessenger, `Burn ${a.amount} USDC on Base Sepolia (CCTP V2)`,
            encodeFunctionData({
              abi: cctpAbi,
              functionName: "depositForBurn",
              args: [amount, MONAD_TESTNET.cctpDomain, pad(account), BASE_SEPOLIA.usdc, pad("0x0"), maxFee,
                maxFee > 0n ? CCTP.fastFinality : CCTP.standardFinality],
            })),
          step("monad-testnet", "cctp-receive", CCTP.messageTransmitter, "Mint USDC on Monad (receiveMessage)"),
        );
        // Minted amount is at least amount - maxFee, so the rest of the plan never over-spends.
        available = (available ?? 0n) + amount - maxFee;
        break;
      }
      case "swap": {
        const amount = typeof a.amount === "string"
          ? toUnits(a.amount, "USDC")
          : ((available ?? 0n) * fractionToBps(a.amount.fractionOfPrevious)) / 10_000n;
        take(amount, "swap");
        swapTotal += amount;
        break;
      }
      case "deposit": {
        const amount = a.amount === "remaining" ? (available ?? 0n) : toUnits(a.amount, "USDC");
        take(amount, "deposit");
        depositTotal += amount;
        break;
      }
      case "transfer": {
        if (!isAddress(a.to) || !allowed.has(getAddress(a.to))) {
          throw new PolicyError("RecipientNotAllowed", `recipient ${a.to} is not in your allowlist`);
        }
        const to = getAddress(a.to);
        if (a.token === "USDC") {
          const amount = toUnits(a.amount, "USDC");
          budget += amount;
          const usdc = a.chain === "monad-testnet" ? MONAD_TESTNET.usdc : BASE_SEPOLIA.usdc;
          steps.push(step(a.chain, "transfer", usdc, `Send ${a.amount} USDC to ${to}`,
            encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] })));
        } else {
          steps.push(step(a.chain, "transfer", to, `Send ${a.amount} MON to ${to}`, "0x", toUnits(a.amount, "MON")));
        }
        break;
      }
    }
  }

  let executorPlan: ExecutorPlan | undefined;
  const amountIn = swapTotal + depositTotal;
  if (amountIn > 0n) {
    if (amountIn > EXECUTOR_LIMITS.maxPlanAmount) {
      throw new PolicyError("OverPlanLimit", `plan moves ${amountIn} USDC units, max per plan is ${EXECUTOR_LIMITS.maxPlanAmount}`);
    }
    let minAmountOut = 0n;
    if (swapTotal > 0n) {
      if (!ctx.reserves) throw new PolicyError("InvalidPlan", "pool reserves are needed to bound slippage");
      minAmountOut = (miniSwapAmountOut(swapTotal, ctx.reserves.usdc, ctx.reserves.wmon) * (10_000n - slippageBps)) / 10_000n;
    }
    executorPlan = {
      account,
      amountIn,
      swapAmount: swapTotal,
      minAmountOut,
      unwrap: true,
      nonce: ctx.nonce,
      deadline: ctx.now + ttlSeconds,
    };
    steps.push(
      step("monad-testnet", "approve", MONAD_TESTNET.usdc, "Approve USDC to PlanExecutor",
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MONAD_TESTNET.planExecutor, amountIn] })),
      step("monad-testnet", "execute", MONAD_TESTNET.planExecutor, "Swap + vault deposit (passkey verified on-chain)"),
    );
  }

  const weeklyCap = intent.limits?.weeklyCap ? toUnits(intent.limits.weeklyCap.amount, "USDC") : undefined;
  if (weeklyCap !== undefined && weeklyCap > EXECUTOR_LIMITS.maxWeeklyCap) {
    throw new PolicyError("InvalidPlan", `weekly cap above the ${EXECUTOR_LIMITS.maxWeeklyCap} ceiling`);
  }
  const remaining = [weeklyCap, ctx.weeklyRemaining].filter((x): x is bigint => x !== undefined);
  for (const r of remaining) {
    if (budget > r) throw new PolicyError("OverWeeklyCap", `plan spends ${budget} USDC units, weekly allowance left is ${r}`);
  }

  const planId = executorPlan
    ? planHash(executorPlan, MONAD_TESTNET.id, MONAD_TESTNET.planExecutor)
    : keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256[]" }, { type: "address[]" }, { type: "bytes[]" }],
        [account, ctx.nonce, ctx.now, steps.map((s) => BigInt(s.chainId)), steps.map((s) => s.to), steps.map((s) => s.data ?? "0x")],
      ));

  return {
    intent,
    steps,
    executorPlan,
    planId,
    commit: { usdcBudget: budget, ttlSeconds, maxSignatures: steps.length },
    weeklyCap,
  };
}
