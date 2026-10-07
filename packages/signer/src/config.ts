import { BASE_SEPOLIA, MONAD_TESTNET } from "@intentguard/core";

export type IntentGuardConfig = {
  nearRpc: string;
  /** NEAR policy contract (also the Chain Signatures predecessor). */
  policy: string;
  monadRpc: string;
  baseRpc: string;
  /** Circle Iris API; the browser goes through the app's /api/cctp proxy. */
  irisApi: string;
};

// Testnet deployment (deployments/near-testnet.json). Override per environment.
export const DEFAULT_CONFIG: IntentGuardConfig = {
  nearRpc: "https://rpc.testnet.near.org",
  policy: "intentguard-973f6c.testnet",
  monadRpc: MONAD_TESTNET.rpc,
  baseRpc: BASE_SEPOLIA.rpc,
  irisApi: "https://iris-api-sandbox.circle.com",
};

export const nearTxUrl = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
