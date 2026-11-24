/**
 * x402-style receipts built from the shared log events.
 * consumed / executed produce a receipt; blocked, rejected and expired produce none.
 * Refunds carry `refundOf`. Deterministic, fail-closed, no duplicates for the same planId.
 * Pure TS: no network, no keys, no signing.
 */
import type { QueueEvent } from "./events";
import { asAmount, asFiniteNumber, guardEvent, lowerPlanId, upperToken, ZERO_PLAN } from "./guards";


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

const ZERO_HASH = ZERO_PLAN;
const safePlanId = (id: unknown): `0x${string}` => lowerPlanId(id) ?? ZERO_PLAN;

/** Hard maximum for operator-supplied maxTtlMs/window. null/missing → no cap. Above this → BAD_CONFIG (never clamped). */
const RECEIPTS_WINDOW_MAX_MS = 7 * 86_400_000; // 7 days

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
    return this.history.has(safePlanId(planId));
  }

  get(planId: string): Receipt | undefined {
    return this.history.get(safePlanId(planId));
  }

  add(r: Receipt): boolean {
    const id = lowerPlanId(r.planId);
    if (!id) return false;
    if (this.history.has(id)) return false;
    this.history.set(id, r);
    return true;
  }

  lookup(planId: unknown, o?: { now?: number }):
    { ok: true; receipt: Receipt } | { ok: false; reason: string; event: import("./events").QueueEvent } {
    const now = asFiniteNumber(o?.now) ?? Date.now();
    const id = lowerPlanId(planId);
    if (!id) {
      return { ok: false, reason: "MALFORMED", event: guardEvent({ kind: "blocked", planId: ZERO_HASH, reason: "MALFORMED", amount: 0n, now, id: null }) };
    }
    const receipt = this.history.get(id);
    if (!receipt) {
      return { ok: false, reason: "Unknown", event: guardEvent({ kind: "blocked", planId: id, reason: "Unknown", amount: 0n, now, id }) };
    }
    return { ok: true, receipt };
  }

  /** Drops nothing from history: a remove must not reset the per-id record. */
  remove(planId: string): void {
    void safePlanId(planId);
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
      if (now == null || (o.store && !o.store.acceptNow(now))) {
        return { receipts: [], skipped: [{ event: o.now, reason: "BAD_NOW" }] };
      }
    } else if (o.store) {
      // no explicit now: do not touch lastNow
    }
    if ("maxTtlMs" in o && o.maxTtlMs !== undefined && o.maxTtlMs !== null) {
      const cap = asFiniteNumber(o.maxTtlMs);
      if (cap == null || cap <= 0 || cap > RECEIPTS_WINDOW_MAX_MS) {
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


/**
 * Parse an ISO timestamp. Impossible calendar dates (e.g. 2026-02-31, which
 * Date rolls to 3 March) are rejected: the value is parsed, reformatted with
 * toISOString(), and must match the input (or the same instant written as …Z
 * without milliseconds).
 */
function parseIsoTs(s: unknown): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const raw = s.trim();
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  const iso = new Date(t).toISOString();
  if (raw === iso) return raw;
  if (raw === iso.replace(/\.000Z$/, "Z")) return raw;
  return null;
}

function parseReceipt(ev: unknown): { receipt: Receipt } | { skip: string; silent?: boolean } {
  if (!ev || typeof ev !== "object") return { skip: "MALFORMED" };
  const e = ev as LogEvent;
  const kind = typeof e.kind === "string" ? e.kind : "";
  const looksRefund = (typeof kind === "string" && /refund/i.test(kind)) || e.refundOf !== undefined;
  // A refund-like kind or an event with refundOf is never skipped silently.
  if (looksRefund && kind !== "refunded") {
    return { skip: "unexpected_refund" };
  }
  if (NO_RECEIPT.has(kind) && kind !== "refunded") return { skip: "no_receipt", silent: true };
  const isRefund = kind === "refunded" || e.refundOf !== undefined;
  if (!PAYMENT_KINDS.has(kind) && !isRefund) {
    // unknown kind: if it looks like a payment (has payer+token+amount) still refuse unless kind is known
    if (!kind) return { skip: "MALFORMED" };
    return { skip: "no_receipt", silent: true };
  }
  if (!isHexPlanId(e.planId)) return { skip: "MALFORMED" };
  const planId = lowerPlanId(e.planId);
  if (!planId) return { skip: "MALFORMED" };
  const amount = asAmount(e.amount);
  if (amount == null) return { skip: "MALFORMED" };
  const payer = normalizePayer(e.payer);
  if (payer === undefined) return { skip: "MALFORMED" };
  if (typeof e.token !== "string" || !e.token.trim()) return { skip: "MALFORMED" };
  const token = upperToken(e.token);
  if (!token) return { skip: "MALFORMED" };
  const ts = parseIsoTs(e.ts);
  if (!ts) return { skip: "MALFORMED" };
  let refundOf: `0x${string}` | undefined;
  if (e.refundOf !== undefined) {
    if (!isHexPlanId(e.refundOf)) return { skip: "MALFORMED" };
    const rid = lowerPlanId(e.refundOf);
    if (!rid) return { skip: "MALFORMED" };
    refundOf = rid;
  }
  const receipt: Receipt = { planId, payer, amount, token, ts };
  if (refundOf) receipt.refundOf = refundOf;
  return { receipt };
}
