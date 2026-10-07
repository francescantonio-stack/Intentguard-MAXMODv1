import type { Address } from "viem";

// Testnet only (docs/CLAUDE.md §2). Addresses from deployments/*.json and docs/CLAUDE.md §4.
export const MONAD_TESTNET = {
  id: 10143,
  name: "monad-testnet",
  rpc: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadexplorer.com",
  cctpDomain: 15,
  usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address,
  wmon: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541" as Address,
  planExecutor: "0x3f1391EC12002E10E18Efa82Af5E491f8159faC1" as Address,
  miniSwap: "0x3D06B01a6B164322013547BEB4Fe0AfF985870f8" as Address,
  demoVault: "0x66C210D79d24a09FCa1F8Aae8c3a98A58F578914" as Address,
} as const;

export const BASE_SEPOLIA = {
  id: 84532,
  name: "base-sepolia",
  rpc: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org",
  cctpDomain: 6,
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
} as const;

// Circle CCTP V2, same addresses on both testnets.
export const CCTP = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
  fastFinality: 1000,
  standardFinality: 2000,
} as const;

/** PlanExecutor immutables on the Monad testnet deployment. */
export const EXECUTOR_LIMITS = {
  maxPlanAmount: 100_000_000n, // 100 USDC
  maxWeeklyCap: 1_000_000_000n, // 1000 USDC
} as const;

export const DECIMALS = { USDC: 6, MON: 18 } as const;
export type Token = keyof typeof DECIMALS;
export type ChainName = typeof MONAD_TESTNET.name | typeof BASE_SEPOLIA.name;

export const explorerTx = (chain: ChainName, hash: string) =>
  `${chain === "monad-testnet" ? MONAD_TESTNET.explorer : BASE_SEPOLIA.explorer}/tx/${hash}`;
