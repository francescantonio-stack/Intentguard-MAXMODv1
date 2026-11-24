import type { Hex } from "viem";

/**
 * Shared event type fixed by Primo (review of grok/hunter-coda-approvazione).
 * Not yet on the default branch of this repo: defined here identically so simulation,
 * the network probe and the counterparty check can emit the same records.
 * When the canonical export lands in packages/core, drop this file and import from there.
 */
export type QueueEvent = {
  kind: "queued" | "auto_approved" | "approved" | "rejected" | "expired" | "consumed" | "blocked";
  planId: `0x${string}`;
  reason: string;
  amount: bigint; // base units, never .toString()
  ts: string;
  id: string | null;
};

/** Short reason codes for our blocks (same vocabulary as the review). */
export type BlockReason =
  | "SimRevert"
  | "SimUnavailable"
  | "UnlimitedApprove"
  | "MalformedApproval"
  | "InsufficientBalance"
  | "MissingPlanId"
  | "CounterpartyDenylisted"
  | "ZeroAddress"
  | "LookalikeAddress"
  | "NewCounterparty"
  | "CounterpartyContract"
  | "Delegated7702"
  | "CodeUnavailable"
  | "BadAmount"
  | "NotAllowlisted"
  | "BadConfig";

export const normalizePlanId = (planId: string): Hex => {
  const s = planId.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(s)) throw new Error("BAD_VALUE: planId non è un bytes32 hex");
  return s as Hex;
};

export const normalizeAddress = (addr: string): `0x${string}` => addr.trim().toLowerCase() as `0x${string}`;

export const normalizeToken = (token: string): string => token.trim().toUpperCase();

const ZERO_PLAN = ("0x" + "00".repeat(32)) as Hex;

export function blockedEvent(o: {
  planId: string;
  reason: BlockReason | string;
  amount: bigint;
  ts?: string | number;
  id?: string | null;
}): QueueEvent {
  let planId: Hex = ZERO_PLAN;
  try { planId = normalizePlanId(o.planId); } catch { /* fail-closed: keep zero planId */ }
  return {
    kind: "blocked",
    planId,
    reason: o.reason,
    amount: typeof o.amount === "bigint" ? o.amount : 0n,
    ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? new Date(o.ts).toISOString() : (typeof o.ts === "string" ? o.ts : new Date().toISOString()),
    id: o.id ?? null,
  };
}
