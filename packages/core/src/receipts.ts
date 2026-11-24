/**
 * x402-style receipts built from the shared log events.
 * consumed / executed produce a receipt; blocked, rejected and expired produce none.
 * Refunds carry `refundOf`. Deterministic, fail-closed, no duplicates for the same planId.
 * Pure TS: no network, no keys, no signing.
 */
import type { QueueEvent } from "./events";


type GuardEvent = QueueEvent;

export type Receipt = {
  planId: `0x${string}`;
  payer: string;
  amount: bigint;
  token: string;
  ts: string;
  refundOf?: `0x${string}`;
};

export type SkippedEvent = { event: unknown; reason: string };

export const lowerPlanId = (id: string): `0x${string}` => {
  const s = id.trim();
  return (s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`).toLowerCase() as `0x${string}`;
};

export const upperToken = (t: string) => t.trim().toUpperCase();

export function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
    return Number(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function asAmount(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return BigInt(v);
  return undefined;
}

const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;
const PLAN_ID_RE = /^0x[0-9a-f]{64}$/;
const ADDR40_RE = /^0x[0-9a-f]{40}$/;
const PAYMENT_KINDS = new Set(["consumed", "executed", "refunded"]);
const NO_RECEIPT = new Set(["blocked", "rejected", "expired", "queued", "auto_approved", "approved"]);

/**
 * Remembers receipts per planId and the last accepted clock value.
 * Removing a receipt from the "live" set does not reset history, so a recreate
 * of the same planId cannot issue a second receipt.
 */
export class ReceiptStore {
  private history = new Map<string, Receipt>();
  private lastNow: number | undefined;

  acceptNow(now: number): boolean {
    if (!Number.isFinite(now)) return false;
    if (this.lastNow !== undefined && now < this.lastNow) return false;
    this.lastNow = now;
    return true;
  }

  has(planId: string): boolean {
    return this.history.has(lowerPlanId(planId));
  }

  get(planId: string): Receipt | undefined {
    return this.history.get(lowerPlanId(planId));
  }

  add(r: Receipt): boolean {
    const id = lowerPlanId(r.planId);
    if (this.history.has(id)) return false;
    this.history.set(id, r);
    return true;
  }

  /** Drops nothing from history: a remove must not reset the per-id record. */
  remove(planId: string): void {
    void lowerPlanId(planId);
  }

  get size() { return this.history.size; }
}

function isHexPlanId(s: unknown): s is string {
  return typeof s === "string" && PLAN_ID_RE.test(s.trim().toLowerCase());
}

function normalizePayer(p: unknown): string | undefined {
  if (typeof p !== "string" || !p.trim()) return undefined;
  const s = p.trim();
  if (/^0x[0-9a-fA-F]+$/i.test(s)) {
    const low = s.toLowerCase();
    // Addresses stay visible only as 0x+40, never 0x+64.
    if (ADDR40_RE.test(low)) return low as `0x${string}`;
    return undefined;
  }
  return s;
}

type LogEvent = {
  kind?: unknown;
  planId?: unknown;
  reason?: unknown;
  amount?: unknown;
  ts?: unknown;
  id?: unknown;
  payer?: unknown;
  token?: unknown;
  refundOf?: unknown;
};

/**
 * Build receipts from a list of log events. Never throws.
 * Malformed events are skipped and reported. Duplicates of the same planId are skipped.
 * The returned list is sorted by `ts` then `planId`.
 */
export function receiptsFromEvents(
  events: unknown,
  o: { store?: ReceiptStore; now?: unknown; maxTtlMs?: number } = {},
): { receipts: Receipt[]; skipped: SkippedEvent[] } {
  const receipts: Receipt[] = [];
  const skipped: SkippedEvent[] = [];
  try {
    if ("now" in o && o.now !== undefined) {
      const now = asFiniteNumber(o.now);
      if (now === undefined || (o.store && !o.store.acceptNow(now))) {
        return { receipts: [], skipped: [{ event: o.now, reason: "BAD_NOW" }] };
      }
    } else if (o.store) {
      // no explicit now: do not touch lastNow
    }
    if ("maxTtlMs" in o && o.maxTtlMs !== undefined) {
      const cap = asFiniteNumber(o.maxTtlMs);
      if (cap === undefined || cap <= 0) {
        return { receipts: [], skipped: [{ event: o.maxTtlMs, reason: "BAD_CONFIG: maxTtlMs" }] };
      }
    }
    if (events == null || !Array.isArray(events)) {
      return { receipts: [], skipped: [{ event: events, reason: "MALFORMED" }] };
    }
    for (const ev of events) {
      const parsed = parseReceipt(ev);
      if ("skip" in parsed) {
        if (parsed.silent) continue;
        skipped.push({ event: ev, reason: parsed.skip });
        continue;
      }
      const rec = parsed.receipt;
      if (o.store?.has(rec.planId)) {
        skipped.push({ event: ev, reason: "duplicate" });
        continue;
      }
      // in-batch duplicate
      if (receipts.some((r) => r.planId === rec.planId)) {
        skipped.push({ event: ev, reason: "duplicate" });
        continue;
      }
      receipts.push(rec);
    }
    receipts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));
    if (o.store) {
      for (const r of receipts) o.store.add(r);
    }
    return { receipts, skipped };
  } catch {
    return { receipts: [], skipped: [{ event: events, reason: "MALFORMED" }] };
  }
}

function parseReceipt(ev: unknown): { receipt: Receipt } | { skip: string; silent?: boolean } {
  if (!ev || typeof ev !== "object") return { skip: "MALFORMED" };
  const e = ev as LogEvent;
  const kind = typeof e.kind === "string" ? e.kind : "";
  if (NO_RECEIPT.has(kind) && kind !== "refunded") return { skip: "no_receipt", silent: true };
  const isRefund = kind === "refunded" || e.refundOf !== undefined;
  if (!PAYMENT_KINDS.has(kind) && !isRefund) {
    // unknown kind: if it looks like a payment (has payer+token+amount) still refuse unless kind is known
    if (!kind) return { skip: "MALFORMED" };
    return { skip: "no_receipt", silent: true };
  }
  if (!isHexPlanId(e.planId)) return { skip: "MALFORMED" };
  const planId = lowerPlanId(e.planId);
  const amount = asAmount(e.amount);
  if (amount === undefined) return { skip: "MALFORMED" };
  const payer = normalizePayer(e.payer);
  if (payer === undefined) return { skip: "MALFORMED" };
  if (typeof e.token !== "string" || !e.token.trim()) return { skip: "MALFORMED" };
  const token = upperToken(e.token);
  if (typeof e.ts !== "string" || !e.ts) return { skip: "MALFORMED" };
  let refundOf: `0x${string}` | undefined;
  if (e.refundOf !== undefined) {
    if (!isHexPlanId(e.refundOf)) return { skip: "MALFORMED" };
    refundOf = lowerPlanId(e.refundOf as string);
  }
  const receipt: Receipt = { planId, payer, amount, token, ts: e.ts };
  if (refundOf) receipt.refundOf = refundOf;
  return { receipt };
}
