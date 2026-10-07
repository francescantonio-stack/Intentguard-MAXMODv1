import { DEFAULT_CONFIG, type IntentGuardConfig } from "@intentguard/signer";

export const POLICY = process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID || DEFAULT_CONFIG.policy;
export const DEMO_COMMAND =
  "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana.";

/** Browser config: RPCs go through same-origin proxies (no CORS surprises), absolute URLs for viem/near-api-js. */
export function cfg(): IntentGuardConfig {
  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  const abs = (p: string) => new URL(p, origin).toString();
  return {
    nearRpc: abs(process.env.NEXT_PUBLIC_NEAR_RPC_URL || "/api/rpc/near"),
    policy: POLICY,
    monadRpc: abs(process.env.NEXT_PUBLIC_MONAD_RPC_URL || "/api/rpc/monad"),
    baseRpc: abs(process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "/api/rpc/base"),
    irisApi: abs("/api/cctp"),
  };
}

export const FAUCETS = {
  mon: "https://faucet.monad.xyz",
  usdc: "https://faucet.circle.com",
  baseEth: "https://portal.cdp.coinbase.com/products/faucet",
};
