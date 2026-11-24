import type { Address, Hex } from "viem";
import { planHash, type ExecutorPlan } from "./planHash";
import type { QueueEvent } from "./events";
import { asAmount, asFiniteNumber, lowerAddress, lowerPlanId } from "./guards";
import { cappedNumber, isConfigObject } from "./limits";

/**
 * Offline verification of a planHash and of QueueEvent receipts.
 * No network, no RPC, no keys. Uses the existing PlanExecutor planHash() exactly.
 */

export const VERIFY_DEFAULTS = { maxEvents: 10_000 } as const;
/** Hard caps: maxEvents and CLI JSON size. Above max -> FAIL/BadConfig, never silently accepted. */
export const VERIFY_MAX = { maxEvents: 10_000, jsonBytes: 16 * 1024 } as const;

export type CheckResult = { name: string; ok: boolean; reason?: string };

export type VerifyReport = {
  ok: boolean;
  checks: CheckResult[];
  computedPlanHash?: Hex;
  claimedPlanHash?: Hex;
};

const KINDS = new Set<QueueEvent["kind"]>([
  "queued", "auto_approved", "approved", "rejected", "expired", "consumed", "blocked",
]);
const TERMINAL = new Set<QueueEvent["kind"]>(["consumed", "rejected", "expired", "blocked"]);

const NEXT: Record<string, ReadonlySet<string>> = {
  "": new Set(["queued", "auto_approved", "blocked"]),
  queued: new Set(["approved", "auto_approved", "rejected", "expired", "blocked"]),
  auto_approved: new Set(["consumed", "expired", "blocked"]),
  approved: new Set(["consumed", "expired", "blocked", "rejected"]),
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const fail = (checks: CheckResult[], name: string, reason: string): CheckResult => {
  const c = { name, ok: false as const, reason };
  checks.push(c);
  return c;
};
const pass = (checks: CheckResult[], name: string): CheckResult => {
  const c = { name, ok: true as const };
  checks.push(c);
  return c;
};

/** JSON may carry amounts as decimal strings or integers; the typed check is still asAmount (bigint >= 0n). */
export function parseJsonAmount(v: unknown): bigint | null {
  if (typeof v === "bigint") return asAmount(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    try { return asAmount(BigInt(v.trim())); } catch { return null; }
  }
  if (typeof v === "number" && Number.isInteger(v) && Number.isFinite(v)) {
    try { return asAmount(BigInt(v)); } catch { return null; }
  }
  return null;
}

function parsePlan(raw: unknown): { ok: true; plan: ExecutorPlan; chainId: number; executor: Address } | { ok: false; reason: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "plan assente o non valido" };
  const o = raw as Record<string, unknown>;
  const account = lowerAddress(o.account);
  if (!account) return { ok: false, reason: "plan.account non è un indirizzo" };
  const amountIn = parseJsonAmount(o.amountIn);
  const swapAmount = parseJsonAmount(o.swapAmount);
  const minAmountOut = parseJsonAmount(o.minAmountOut);
  if (amountIn === null) return { ok: false, reason: "plan.amountIn non è un bigint >= 0" };
  if (swapAmount === null) return { ok: false, reason: "plan.swapAmount non è un bigint >= 0" };
  if (minAmountOut === null) return { ok: false, reason: "plan.minAmountOut non è un bigint >= 0" };
  if (typeof o.unwrap !== "boolean") return { ok: false, reason: "plan.unwrap deve essere boolean" };
  const nonce = parseJsonAmount(o.nonce);
  const deadline = parseJsonAmount(o.deadline);
  if (nonce === null) return { ok: false, reason: "plan.nonce non è un bigint >= 0" };
  if (deadline === null) return { ok: false, reason: "plan.deadline non è un bigint >= 0" };
  return {
    ok: true,
    plan: { account, amountIn, swapAmount, minAmountOut, unwrap: o.unwrap, nonce, deadline },
    chainId: 0,
    executor: "0x0000000000000000000000000000000000000000",
  };
}

function parseIsoMs(ts: unknown): number | null {
  if (typeof ts !== "string" || !ISO_RE.test(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Verify a plan JSON (recompute planHash) and/or a list of QueueEvent receipts.
 * Never fetches, never throws. Missing or malformed fields become FAIL checks.
 */
export function verifyOffline(input: unknown): VerifyReport {
  const checks: CheckResult[] = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    fail(checks, "input", "input assente o non valido");
    return { ok: false, checks };
  }
  const o = input as Record<string, unknown>;

  if (o.config !== undefined && o.config !== null && !isConfigObject(o.config)) {
    fail(checks, "config", "config non valida");
    return { ok: false, checks };
  }
  const cap = cappedNumber((o.config as { maxEvents?: unknown } | null | undefined)?.maxEvents, VERIFY_DEFAULTS.maxEvents, VERIFY_MAX.maxEvents);
  if (!cap.ok) {
    fail(checks, "config.maxEvents", cap.detail);
    return { ok: false, checks };
  }
  const maxEvents = cap.value;

  // --- planHash ---
  const planRaw = o.plan ?? (o.account !== undefined ? o : undefined);
  const hasPlan = planRaw !== undefined;
  let computed: Hex | undefined;
  let claimed: Hex | undefined;
  let planAmount: bigint | undefined;

  if (hasPlan) {
    const parsed = parsePlan(planRaw);
    if (!parsed.ok) {
      fail(checks, "plan", parsed.reason);
    } else {
      const chainId = asFiniteNumber(o.chainId);
      if (chainId === null || !Number.isInteger(chainId) || chainId <= 0) {
        fail(checks, "chainId", "chainId deve essere un intero finito > 0");
      }
      const executor = lowerAddress(o.executor);
      if (!executor) fail(checks, "executor", "executor non è un indirizzo");
      if (chainId !== null && Number.isInteger(chainId) && chainId > 0 && executor) {
        computed = planHash(parsed.plan, chainId, executor);
        if (o.amount !== undefined) {
          const a = parseJsonAmount(o.amount);
          if (a === null) {
            fail(checks, "amount", "amount non è un bigint >= 0");
          } else {
            planAmount = a;
            pass(checks, "plan");
          }
        } else {
          planAmount = parsed.plan.amountIn;
          pass(checks, "plan");
        }
        if (o.planHash !== undefined || o.planId !== undefined) {
          const rawClaim = o.planHash ?? o.planId;
          const id = lowerPlanId(rawClaim);
          if (!id) {
            fail(checks, "planHash", "planHash/planId dichiarato non è un bytes32 hex");
          } else {
            claimed = id;
            if (id === computed) pass(checks, "planHash");
            else fail(checks, "planHash", `calcolato ${computed} ≠ dichiarato ${id}`);
          }
        } else {
          pass(checks, "planHash"); // computed only, nothing to compare
        }
      }
    }
  }

  // --- events / receipts ---
  if (o.events === undefined && o.receipts === undefined) {
    if (!hasPlan) fail(checks, "input", "manca plan e manca events");
    return { ok: checks.every((c) => c.ok), checks, computedPlanHash: computed, claimedPlanHash: claimed };
  }
  const rawEvents = o.events ?? o.receipts;
  if (!Array.isArray(rawEvents)) {
    fail(checks, "events", "events/receipts deve essere una lista");
    return { ok: false, checks, computedPlanHash: computed, claimedPlanHash: claimed };
  }
  if (rawEvents.length > maxEvents) {
    fail(checks, "events", `troppi eventi (${rawEvents.length} > ${maxEvents})`);
    return { ok: false, checks, computedPlanHash: computed, claimedPlanHash: claimed };
  }

  const events: QueueEvent[] = [];
  let malformed = false;
  for (let i = 0; i < rawEvents.length; i++) {
    const e = rawEvents[i];
    const tag = `evento[${i}]`;
    if (e == null || typeof e !== "object" || Array.isArray(e)) {
      fail(checks, tag, "evento non è un oggetto");
      malformed = true;
      continue;
    }
    const ev = e as Record<string, unknown>;
    if (typeof ev.kind !== "string" || !KINDS.has(ev.kind as QueueEvent["kind"])) {
      fail(checks, tag, "kind mancante o non valido");
      malformed = true;
      continue;
    }
    const planId = lowerPlanId(ev.planId);
    if (!planId) {
      fail(checks, tag, "planId mancante o non è un bytes32 hex");
      malformed = true;
      continue;
    }
    const amount = parseJsonAmount(ev.amount);
    if (amount === null) {
      fail(checks, tag, "amount mancante o non è un bigint >= 0");
      malformed = true;
      continue;
    }
    const tsMs = parseIsoMs(ev.ts);
    if (tsMs === null) {
      fail(checks, tag, "ts mancante o non è un ISO 8601 valido");
      malformed = true;
      continue;
    }
    if (ev.id !== null && ev.id !== undefined && typeof ev.id !== "string") {
      fail(checks, tag, "id deve essere stringa o null");
      malformed = true;
      continue;
    }
    if (typeof ev.reason !== "string") {
      fail(checks, tag, "reason deve essere una stringa");
      malformed = true;
      continue;
    }
    events.push({
      kind: ev.kind as QueueEvent["kind"],
      planId,
      reason: ev.reason,
      amount,
      ts: ev.ts as string,
      id: ev.id === undefined ? null : (ev.id as string | null),
    });
  }
  if (malformed) return { ok: false, checks, computedPlanHash: computed, claimedPlanHash: claimed };
  pass(checks, "events.forma");

  if (computed) {
    const mismatch = events.filter((e) => e.planId !== computed);
    if (mismatch.length) fail(checks, "events.planId", `${mismatch.length} eventi con planId ≠ hash calcolato`);
    else pass(checks, "events.planId");
  }

  if (planAmount !== undefined) {
    const bad = events.filter((e) => e.amount !== planAmount);
    if (bad.length) fail(checks, "events.amount", `importo diverso dal piano (${planAmount}) in ${bad.length} eventi`);
    else pass(checks, "events.amount");
  } else {
    // still require >= 0, already enforced by parseJsonAmount
    pass(checks, "events.amount");
  }

  // duplicate consumed per planId
  const consumedAt = new Map<string, number>();
  let dup = 0;
  events.forEach((e, i) => {
    if (e.kind !== "consumed") return;
    if (consumedAt.has(e.planId)) dup++;
    else consumedAt.set(e.planId, i);
  });
  if (dup) fail(checks, "events.consumed", `consumed duplicato per lo stesso planId (${dup})`);
  else pass(checks, "events.consumed");

  // kind order per planId
  const lastKind = new Map<string, QueueEvent["kind"] | "">();
  let orderFail: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const prev = lastKind.get(e.planId) ?? "";
    if (TERMINAL.has(prev as QueueEvent["kind"])) {
      orderFail = `evento[${i}]: ${e.kind} dopo lo stato terminale ${prev}`;
      break;
    }
    const allowed = NEXT[prev] ?? new Set();
    if (!allowed.has(e.kind)) {
      orderFail = `evento[${i}]: passaggio ${prev || "inizio"} → ${e.kind} non consentito`;
      break;
    }
    lastKind.set(e.planId, e.kind);
  }
  if (orderFail) fail(checks, "events.ordine", orderFail);
  else pass(checks, "events.ordine");

  // ISO timestamps non-decreasing per planId (and in list order for that plan)
  const lastTs = new Map<string, number>();
  let tsFail: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const ms = parseIsoMs(e.ts)!;
    const prev = lastTs.get(e.planId);
    if (prev !== undefined && ms < prev) {
      tsFail = `evento[${i}]: ts ${e.ts} antecedente al precedente dello stesso planId`;
      break;
    }
    lastTs.set(e.planId, ms);
  }
  if (tsFail) fail(checks, "events.ts", tsFail);
  else pass(checks, "events.ts");

  return { ok: checks.every((c) => c.ok), checks, computedPlanHash: computed, claimedPlanHash: claimed };
}

export function formatReport(r: VerifyReport): string {
  const lines = r.checks.map((c) => (c.ok ? `PASS ${c.name}` : `FAIL ${c.name}: ${c.reason ?? ""}`));
  if (r.computedPlanHash) lines.push(`HASH ${r.computedPlanHash}`);
  lines.push(r.ok ? "RESULT PASS" : "RESULT FAIL");
  return lines.join("\n");
}
