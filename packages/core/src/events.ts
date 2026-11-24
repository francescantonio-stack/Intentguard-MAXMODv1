/**
 * Shared event types fixed by Primo.
 * Functions live in `./guards` (lowerPlanId, guardEvent, …). This file stays types-only
 * so `export *` does not clash when other modules also import QueueEvent.
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
