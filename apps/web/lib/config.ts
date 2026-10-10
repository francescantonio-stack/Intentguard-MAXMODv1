import { DEFAULT_CONFIG, type IntentGuardConfig } from "@intentguard/signer";

export const POLICY = process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID || DEFAULT_CONFIG.policy;
export const DEMO_COMMAND =
  "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana.";

/** Origin of this deployment: the request host in the browser, else NEXT_PUBLIC_APP_URL / VERCEL_URL. */
export function appOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim() || process.env.NEXT_PUBLIC_VERCEL_URL?.trim();
  if (vercel) return (vercel.startsWith("http") ? vercel : `https://${vercel}`).replace(/\/$/, "");
  return "http://localhost:3000";
}

/** Browser config: RPCs go through same-origin proxies (no CORS surprises), absolute URLs for viem/near-api-js. */
export function cfg(): IntentGuardConfig {
  const abs = (p: string) => new URL(p, appOrigin()).toString();
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
