import {
  createPublicClient, http, keccak256, recoverAddress, serializeTransaction,
  type Address, type Hex, type PublicClient, type TransactionReceipt, type TransactionSerializableEIP1559,
} from "viem";
import { BASE_SEPOLIA, MONAD_TESTNET, explorerTx, type ChainName } from "@intentguard/core";
import { PolicyRejection, type MpcSignature, type PolicyClient, type TxRequest } from "./near";
import { nearTxUrl, type IntentGuardConfig } from "./config";

const CHAINS = {
  "monad-testnet": { id: MONAD_TESTNET.id, priorityFee: 2_000_000_000n },
  "base-sepolia": { id: BASE_SEPOLIA.id, priorityFee: 1_000_000n },
} as const;

export function publicClient(chain: ChainName, cfg: Pick<IntentGuardConfig, "monadRpc" | "baseRpc">): PublicClient {
  return createPublicClient({ transport: http(chain === "monad-testnet" ? cfg.monadRpc : cfg.baseRpc) }) as PublicClient;
}

/** MPC response -> viem signature parts (r = x of big_r, s, yParity = recovery_id). */
export function mpcToSignature(sig: MpcSignature): { r: Hex; s: Hex; yParity: number } {
  return { r: `0x${sig.big_r.affine_point.slice(2)}`, s: `0x${sig.s.scalar}`, yParity: sig.recovery_id };
}

/** Serializes the signed tx and refuses it unless the MPC signature recovers to the user's derived address. */
export async function assembleSignedTx(unsigned: TransactionSerializableEIP1559, sig: MpcSignature, expected: Address): Promise<Hex> {
  const signature = mpcToSignature(sig);
  const recovered = await recoverAddress({ hash: keccak256(serializeTransaction(unsigned)), signature });
  if (recovered.toLowerCase() !== expected.toLowerCase()) throw new Error(`MPC signature recovers to ${recovered}, expected ${expected}`);
  return serializeTransaction(unsigned, signature);
}

export type StepResult = {
  chain: ChainName;
  txHash: Hex;
  explorer: string;
  nearTx: string;
  nearExplorer: string;
  gasUsed: bigint;
  ms: number;
  receipt: TransactionReceipt;
};

/**
 * One policy-gated tx from the user's derived address: build EIP-1559 fields, free policy dry run (readable
 * rejection), request_signature (NEAR -> MPC), recover-check, broadcast, wait for the receipt.
 * One tx at a time per address (docs/CLAUDE.md §2): callers await each step.
 */
export async function signAndSend(o: {
  cfg: Pick<IntentGuardConfig, "monadRpc" | "baseRpc">;
  policy: PolicyClient;
  account: Address;
  chain: ChainName;
  planId: Hex;
  to: Address;
  data?: Hex;
  value?: bigint;
  log?: (msg: string) => void;
}): Promise<StepResult> {
  const t0 = Date.now();
  const { id, priorityFee } = CHAINS[o.chain];
  const pc = publicClient(o.chain, o.cfg);
  const data = o.data ?? "0x";
  const value = o.value ?? 0n;
  const [nonce, block] = await Promise.all([pc.getTransactionCount({ address: o.account, blockTag: "pending" }), pc.getBlock()]);
  const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + priorityFee;

  // Monad charges the gas LIMIT: estimate x 1.1, never a blanket limit. Retries cover load-balanced RPCs
  // that still serve the state from before the previous step.
  let gas: bigint | undefined;
  for (let i = 0; gas === undefined; i++) {
    try {
      gas = ((await pc.estimateGas({ account: o.account, to: o.to, data, value })) * 11n) / 10n;
    } catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const tx: TxRequest = {
    chain_id: id, nonce, max_priority_fee_per_gas: priorityFee.toString(), max_fee_per_gas: maxFeePerGas.toString(),
    gas_limit: Number(gas), to: o.to, value: value.toString(), data,
  };
  const check = await o.policy.check(o.planId, tx);
  if (!check.ok) throw new PolicyRejection(check.reason ?? "rejected");
  o.log?.(`[${o.chain}] policy ok, asking the MPC network to sign`);

  const { txHash: nearTx, signature } = await o.policy.requestSignature(o.planId, tx);
  const unsigned: TransactionSerializableEIP1559 = {
    type: "eip1559", chainId: id, nonce, maxPriorityFeePerGas: priorityFee, maxFeePerGas, gas, to: o.to, value, data,
  };
  const raw = await assembleSignedTx(unsigned, signature, o.account);
  const txHash = await pc.sendRawTransaction({ serializedTransaction: raw });
  o.log?.(`[${o.chain}] sent ${explorerTx(o.chain, txHash)}`);
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${explorerTx(o.chain, txHash)}`);
  return {
    chain: o.chain, txHash, explorer: explorerTx(o.chain, txHash), nearTx, nearExplorer: nearTxUrl(nearTx),
    gasUsed: receipt.gasUsed, ms: Date.now() - t0, receipt,
  };
}
