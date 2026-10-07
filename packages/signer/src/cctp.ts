import type { Hex } from "viem";
import { BASE_SEPOLIA, CCTP, MONAD_TESTNET } from "@intentguard/core";

const SRC = BASE_SEPOLIA.cctpDomain;
const DST = MONAD_TESTNET.cctpDomain;

/**
 * Fast-transfer max fee for `amount` (USDC units): Circle's minimum fee for finality 1000, doubled, +1.
 * `iris` is Circle's API base or the app's /api/cctp proxy.
 */
export async function cctpFastMaxFee(iris: string, amount: bigint, fetcher: typeof fetch = fetch): Promise<bigint> {
  const fees = (await (await fetcher(`${iris}/v2/burn/USDC/fees/${SRC}/${DST}`)).json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
  const bps = fees.find((f) => f.finalityThreshold === CCTP.fastFinality)?.minimumFee ?? 0;
  // bps can be fractional (e.g. 1.3): scale to 1/10000 bps to stay in bigint.
  const scaled = BigInt(Math.round(bps * 10_000));
  return ((amount * scaled + 100_000_000n - 1n) / 100_000_000n) * 2n + 1n;
}

export type Attestation = { message: Hex; attestation: Hex };

/** Polls Circle Iris until the burn on Base Sepolia is attested. */
export async function waitForAttestation(
  iris: string,
  burnTxHash: Hex,
  o: { timeoutMs?: number; intervalMs?: number; fetcher?: typeof fetch; onTick?: (elapsedMs: number) => void } = {},
): Promise<Attestation> {
  const t0 = Date.now();
  const fetcher = o.fetcher ?? fetch;
  while (Date.now() - t0 < (o.timeoutMs ?? 20 * 60_000)) {
    const r = await fetcher(`${iris}/v2/messages/${SRC}?transactionHash=${burnTxHash}`);
    if (r.ok) {
      const m = ((await r.json()) as { messages?: Array<{ status?: string; message?: Hex; attestation?: string }> }).messages?.[0];
      if (m?.status === "complete" && m.message && m.attestation?.startsWith("0x")) {
        return { message: m.message, attestation: m.attestation as Hex };
      }
    }
    o.onTick?.(Date.now() - t0);
    await new Promise((res) => setTimeout(res, o.intervalMs ?? 3000));
  }
  throw new Error("CCTP attestation timeout");
}
