import type { Hex } from "viem";
import type { QueueEvent } from "./events";

/**
 * Shared fail-closed helpers. Fonte unica per Moon e Hunter (import da `./guards`,
 * non copiare e non riesportare). events.ts resta solo tipi (QueueEvent, BlockReason).
 */

export const ZERO_PLAN = ("0x" + "00".repeat(32)) as Hex;
const PLAN_RE = /^0x[0-9a-f]{64}$/;

/** Validate 0x+64 hex and lowercase. Invalid input → null (never throws). */
export function lowerPlanId(id: unknown): `0x${string}` | null {
  if (typeof id !== "string") return null;
  const s = id.trim().toLowerCase();
  return PLAN_RE.test(s) ? (s as `0x${string}`) : null;
}

/** Finite number (no NaN, Inf, -0, strings). Safe bigint is accepted. Else null. */
export function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) return null;
    const n = Number(v);
    return Object.is(n, -0) ? 0 : n;
  }
  if (typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0)) return v;
  return null;
}

/** Amount: bigint only, >= 0n. Numbers and strings are rejected. Else null. */
export function asAmount(v: unknown): bigint | null {
  return typeof v === "bigint" && v >= 0n ? v : null;
}

/** Trim and uppercase a token symbol. Non-string or empty → null. */
export function upperToken(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const s = t.trim();
  return s ? s.toUpperCase() : null;
}

export function lowerAddress(addr: unknown): `0x${string}` | null {
  if (typeof addr !== "string") return null;
  const s = addr.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? (s as `0x${string}`) : null;
}

/**
 * Build a QueueEvent. Default kind is "blocked".
 * Invalid planId → zero plan (fail-closed, no throw). Invalid amount → 0n.
 * `now` must be a finite number for a stable timestamp; otherwise Date.now() is used.
 */
export function guardEvent(o: {
  kind?: QueueEvent["kind"];
  planId: unknown;
  reason: string;
  amount?: unknown;
  now?: number;
  ts?: string | number;
  id?: string | null;
}): QueueEvent {
  let ts: string;
  if (typeof o.ts === "string") ts = o.ts;
  else if (typeof o.ts === "number" && Number.isFinite(o.ts)) ts = new Date(o.ts).toISOString();
  else if (o.now !== undefined && Number.isFinite(o.now)) ts = new Date(o.now).toISOString();
  else ts = new Date().toISOString();
  const amount = asAmount(o.amount) ?? 0n;
  return {
    kind: o.kind ?? "blocked",
    planId: lowerPlanId(o.planId) ?? ZERO_PLAN,
    reason: o.reason,
    amount,
    ts,
    id: o.id ?? null,
  };
}

/** @deprecated use lowerPlanId (returns null instead of throwing). */
export function normalizePlanId(planId: string): Hex {
  const id = lowerPlanId(planId);
  if (!id) throw new Error("BAD_VALUE: planId non è un bytes32 hex");
  return id;
}

/** @deprecated use lowerAddress. */
export const normalizeAddress = (addr: string): `0x${string}` =>
  lowerAddress(addr) ?? (addr.trim().toLowerCase() as `0x${string}`);

/** @deprecated use upperToken. */
export const normalizeToken = (token: string): string => upperToken(token) ?? token.trim().toUpperCase();

/** Blocked QueueEvent (alias of guardEvent with kind "blocked"). */
export function blockedEvent(o: {
  planId: unknown;
  reason: string;
  amount?: unknown;
  ts?: string | number;
  now?: number;
  id?: string | null;
}): QueueEvent {
  return guardEvent({ ...o, kind: "blocked" });
}
