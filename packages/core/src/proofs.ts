/**
 * Mandatory proof before payment (SUFFICIA idea).
 * A plan declares the proofs it requires. If any required proof is missing, malformed,
 * the wrong type, expired or fails verification, the plan stays blocked and an event
 * is written in the shared format. Pure TS: no network, no keys, no signing. Fail-closed.
 */
import type { QueueEvent } from "./events";
import { asAmount, asFiniteNumber, guardEvent, lowerPlanId, ZERO_PLAN } from "./guards";


type GuardEvent = QueueEvent;

const ZERO_HASH = ZERO_PLAN;
const safePlanId = (id: unknown): `0x${string}` => lowerPlanId(id) ?? ZERO_PLAN;

/** Hard maximum for operator-supplied maxTtlMs. null/missing → no cap. Above this → BAD_CONFIG (never clamped). */
const PROOFS_MAX_TTL_MS = 86_400_000; // 24h

const HASH_RE = /^0x[0-9a-f]{64}$/;

export type ProofType = "invoice_hash" | "counterparty_attestation" | "delivery_receipt" | "simulation_passed" | (string & {});

export type ProofRequirement = {
  type: ProofType;
  /** invoice_hash: expected SHA-256 (0x + 64 hex). */
  expectedHash?: string;
  /** counterparty_attestation: who must attest. */
  attester?: string;
  /** Optional expiry of the requirement itself. */
  expiresAt?: number;
  id?: string;
};

export type Proof = {
  type: ProofType;
  hash?: string;
  attester?: string;
  receiptId?: string;
  /** simulation_passed: only `ok === true` counts. */
  ok?: unknown;
  expiresAt?: number;
  id?: string;
};

export type ProofPlan = {
  planId: string;
  amount: bigint | number;
  required: ProofRequirement[];
};

export type VerifyOk = { ok: true; event: QueueEvent };
export type VerifyFail = { ok: false; reason: string; event: QueueEvent; events: QueueEvent[] };
export type VerifyResult = VerifyOk | VerifyFail;

export type ProofVerifier = (req: ProofRequirement, proof: Proof | undefined, now: number) => "ok" | "proof_missing" | "proof_invalid" | "proof_expired";

export type ProofHistory = { status: "consumed" | "blocked"; reason: string; amount: bigint };

/**
 * Remembers proof outcomes per planId and the last accepted clock value.
 * Removing a plan does not reset history, so a recreate cannot bypass a prior block or consume.
 */
export class ProofStore {
  private history = new Map<string, ProofHistory>();
  private lastNow: number | undefined;

  acceptNow(now: number): boolean {
    if (!Number.isFinite(now)) return false;
    if (this.lastNow !== undefined && now < this.lastNow) return false;
    this.lastNow = now;
    return true;
  }

  remember(planId: string, rec: ProofHistory) {
    this.history.set(safePlanId(planId), rec);
  }

  historyOf(planId: string) {
    return this.history.get(safePlanId(planId));
  }

  lookup(planId: unknown, o?: { now?: number; onEvent?: (e: QueueEvent) => void }):
    { ok: true; history: ProofHistory } | { ok: false; reason: string; event: QueueEvent } {
    const now = asFiniteNumber(o?.now) ?? Date.now();
    const id = lowerPlanId(planId);
    if (!id) {
      const event = guardEvent({ kind: "blocked", planId: ZERO_HASH, reason: "MALFORMED", amount: 0n, now, id: null });
      o?.onEvent?.(event);
      return { ok: false, reason: "MALFORMED", event };
    }
    const history = this.history.get(id);
    if (!history) {
      const event = guardEvent({ kind: "blocked", planId: id, reason: "Unknown", amount: 0n, now, id });
      o?.onEvent?.(event);
      return { ok: false, reason: "Unknown", event };
    }
    return { ok: true, history };
  }

  /** No-op on history: a "remove" must not reset the per-id record. */
  remove(planId: string) {
    void safePlanId(planId);
  }

  get size() { return this.history.size; }
}

export const builtinVerifiers: Record<string, ProofVerifier> = {
  invoice_hash: (req, proof) => {
    if (!proof) return "proof_missing";
    if (proof.type !== "invoice_hash") return "proof_invalid";
    const got = typeof proof.hash === "string" ? proof.hash.toLowerCase() : "";
    const exp = typeof req.expectedHash === "string" ? req.expectedHash.toLowerCase() : "";
    if (!HASH_RE.test(got) || !HASH_RE.test(exp)) return "proof_invalid";
    return got === exp ? "ok" : "proof_invalid";
  },
  counterparty_attestation: (req, proof, _now) => {
    if (!proof) return "proof_missing";
    if (proof.type !== "counterparty_attestation") return "proof_invalid";
    if (typeof proof.attester !== "string" || !proof.attester) return "proof_invalid";
    if (typeof req.attester !== "string" || !req.attester) return "proof_invalid";
    if (proof.attester.toLowerCase() !== req.attester.toLowerCase()) return "proof_invalid";
    if (proof.expiresAt !== undefined && asFiniteNumber(proof.expiresAt) == null) return "proof_invalid";
    return "ok";
  },
  delivery_receipt: (req, proof, _now) => {
    if (!proof) return "proof_missing";
    if (proof.type !== "delivery_receipt") return "proof_invalid";
    if (typeof proof.receiptId !== "string" || !proof.receiptId) return "proof_invalid";
    if (proof.expiresAt !== undefined && asFiniteNumber(proof.expiresAt) == null) return "proof_invalid";
    return "ok";
  },
  simulation_passed: (_req, proof) => {
    if (!proof) return "proof_missing";
    if (proof.type !== "simulation_passed") return "proof_invalid";
    return proof.ok === true ? "ok" : "proof_invalid";
  },
};

/** Success only when `ok === true`. `{ok: 0}` does not pass. */
export const proofPassed = (r: unknown): r is VerifyOk =>
  typeof r === "object" && r !== null && (r as VerifyResult).ok === true;

export function verifyProofs(
  plan: unknown,
  proofs: unknown,
  o: {
    now?: unknown;
    onEvent?: (e: QueueEvent) => void;
    verifiers?: Record<string, ProofVerifier>;
    amount?: bigint;
    store?: ProofStore;
    /** Optional max lifetime from now. A proof expiry may only tighten this, never widen it. */
    maxTtlMs?: number;
  } = {},
): VerifyResult {
  const emit = (kind: QueueEvent["kind"], planId: string, reason: string, amount: bigint, now: number, id: string | null = null) => {
    const ev = guardEvent({ kind, planId, reason, amount, now, id });
    o.onEvent?.(ev);
    return ev;
  };
  const nowRaw = o.now !== undefined ? o.now : Date.now();
  const now = asFiniteNumber(nowRaw);
  const known = asAmount(o.amount);

  try {
    if (now == null) {
      const ev = emit("blocked", ZERO_HASH, "BAD_NOW", known ?? 0n, Date.now(), null);
      return { ok: false, reason: "BAD_NOW", event: ev, events: [ev] };
    }
    if (o.store && !o.store.acceptNow(now)) {
      const ev = emit("blocked", ZERO_HASH, "BAD_NOW", known ?? 0n, Date.now(), null);
      return { ok: false, reason: "BAD_NOW", event: ev, events: [ev] };
    }
    if ("maxTtlMs" in o && o.maxTtlMs !== undefined && o.maxTtlMs !== null) {
      const cap = asFiniteNumber(o.maxTtlMs);
      if (cap == null || cap <= 0 || cap > PROOFS_MAX_TTL_MS) {
        const ev = emit("blocked", ZERO_HASH, "BAD_CONFIG: maxTtlMs", known ?? 0n, now, null);
        return { ok: false, reason: "BAD_CONFIG: maxTtlMs", event: ev, events: [ev] };
      }
    }
    if (!plan || typeof plan !== "object") {
      const ev = emit("blocked", ZERO_HASH, "MALFORMED", known ?? 0n, now, null);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    const p = plan as ProofPlan;
    if (typeof p.planId !== "string" || !HASH_RE.test(p.planId.toLowerCase())) {
      const ev = emit("blocked", safePlanId(p.planId), "MALFORMED", known ?? asAmount(p.amount) ?? 0n, now, null);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    const planId = lowerPlanId(p.planId);
    if (!planId) {
      const ev = emit("blocked", ZERO_HASH, "MALFORMED", known ?? asAmount(p.amount) ?? 0n, now, null);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    const planAmt = asAmount(p.amount);
    if (p.amount !== undefined && p.amount !== null && planAmt == null) {
      const ev = emit("blocked", planId, "MALFORMED", known ?? 0n, now, planId);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    if (known != null && planAmt != null && known !== planAmt) {
      const ev = emit("blocked", planId, "AmountMismatch", known, now, planId);
      return { ok: false, reason: "AmountMismatch", event: ev, events: [ev] };
    }
    const amount = known ?? planAmt;
    if (amount == null) {
      const ev = emit("blocked", planId, "MALFORMED", 0n, now, planId);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    if (amount < 0n) {
      const ev = emit("blocked", planId, "MALFORMED", amount, now, planId);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    const prior = o.store?.historyOf(planId);
    if (prior) {
      const ev = emit("blocked", planId, prior.status === "consumed" ? "Consumed" : prior.reason, amount, now, planId);
      return { ok: false, reason: ev.reason, event: ev, events: [ev] };
    }
    if (!Array.isArray(p.required) || p.required.length === 0) {
      const ev = emit("blocked", planId, "NO_REQUIRED", amount, now, planId);
      if (o.store) o.store.remember(planId, { status: "blocked", reason: "NO_REQUIRED", amount });
      return { ok: false, reason: "NO_REQUIRED", event: ev, events: [ev] };
    }
    const list = Array.isArray(proofs) ? proofs : null;
    if (list === null) {
      const ev = emit("blocked", planId, "MALFORMED", amount, now, planId);
      return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
    }
    const offered = list.filter((x): x is Proof => !!x && typeof x === "object" && typeof (x as Proof).type === "string");
    const verifiers = { ...builtinVerifiers, ...(o.verifiers ?? {}) };
    const events: QueueEvent[] = [];
    const used = new Set<number>();
    const maxTtl = "maxTtlMs" in o && o.maxTtlMs !== undefined ? asFiniteNumber(o.maxTtlMs) : undefined;

    const effectiveExpiry = (req: ProofRequirement, proof: Proof | undefined): { ok: true; exp?: number } | { ok: false; reason: string } => {
      const raw = [req.expiresAt, proof?.expiresAt];
      for (const v of raw) {
        if (v !== undefined && asFiniteNumber(v) == null) return { ok: false, reason: "proof_invalid" };
      }
      const caps: number[] = [];
      const reqExp = asFiniteNumber(req.expiresAt);
      const proofExp = asFiniteNumber(proof?.expiresAt);
      if (reqExp != null) caps.push(reqExp);
      if (proofExp != null) caps.push(proofExp);
      if (maxTtl != null) {
        const cap = now + maxTtl;
        if (caps.length === 0) return { ok: false, reason: "proof_invalid" };
        if (caps.some((e) => e > cap)) return { ok: false, reason: "proof_expired" };
      }
      const exp = caps.length ? Math.min(...caps) : undefined;
      return { ok: true, exp };
    };

    for (const req of p.required) {
      if (!req || typeof req !== "object" || typeof req.type !== "string" || !req.type) {
        const ev = emit("blocked", planId, "proof_invalid", amount, now, planId);
        events.push(ev);
        continue;
      }
      const idx = offered.findIndex((pr, i) => !used.has(i) && pr.type === req.type && (req.id === undefined || pr.id === req.id));
      const proof = idx >= 0 ? offered[idx] : undefined;
      if (idx >= 0) used.add(idx);
      const expiry = effectiveExpiry(req, proof);
      if (!expiry.ok) {
        const ev = emit("blocked", planId, expiry.reason, amount, now, req.id ?? planId);
        events.push(ev);
        continue;
      }
      if (expiry.exp !== undefined && now > expiry.exp) {
        const ev = emit("blocked", planId, "proof_expired", amount, now, req.id ?? planId);
        events.push(ev);
        continue;
      }
      const verify = verifiers[req.type];
      if (!verify) {
        const ev = emit("blocked", planId, "proof_invalid", amount, now, req.id ?? planId);
        events.push(ev);
        continue;
      }
      const verdict = verify(req, proof, now);
      if (verdict !== "ok") {
        const ev = emit("blocked", planId, verdict, amount, now, req.id ?? planId);
        events.push(ev);
      }
    }
    if (events.length) {
      if (o.store) o.store.remember(planId, { status: "blocked", reason: events[0]!.reason, amount });
      return { ok: false, reason: events[0]!.reason, event: events[0]!, events };
    }
    const event = emit("consumed", planId, "ProofsOk", amount, now, planId);
    if (o.store) o.store.remember(planId, { status: "consumed", reason: "ProofsOk", amount });
    return { ok: true, event };
  } catch {
    const ev = emit("blocked", ZERO_HASH, "MALFORMED", known ?? 0n, asFiniteNumber(o.now) ?? Date.now(), null);
    return { ok: false, reason: "MALFORMED", event: ev, events: [ev] };
  }
}
