/**
 * SAFE HOLD: the agent stops when data is stale, missing or uncertain.
 * Pure, read-only: no network, no keys, no signing.
 * Result is "PROCEED" only if EVERY check passes, otherwise "HOLD" with the reasons (fail-closed).
 * Blocks are reported with the shared QueueEvent shape (ActionBlocked(planId, reason, amount)).
 */
import type { QueueEvent } from "./approvalQueue";

export type SafeHoldCode =
  | "BAD_NOW" | "BAD_INPUT" | "BAD_CONFIG" | "MALFORMED" | "BAD_VALUE" | "NO_TIMESTAMP"
  | "FUTURE_TIMESTAMP" | "STALE" | "LOW_CONFIDENCE" | "MISSING" | "TOO_FEW_SOURCES" | "SOURCES_DISAGREE" | "CHECK_ERROR";

export interface Observation {
  key: string;
  value: number;
  observedAt: number; // ms
  source?: string;
  confidence?: number; // 0..1
  maxAgeSec?: number;
}
export interface SafeHoldConfig {
  maxAgeSec: number;
  maxFutureSkewSec: number;
  maxDeviationPct: number;
  minSources: number;
  minConfidence: number;
}
export interface SafeHoldReason { code: SafeHoldCode; key?: string; detail: string }
export interface SafeHoldResult { decision: "PROCEED" | "HOLD"; reasons: SafeHoldReason[]; checkedAt: number }
export interface SafeHoldInput {
  observations?: Observation[];
  required?: string[];
  now?: number;
  config?: Partial<SafeHoldConfig>;
}

export const SAFE_HOLD_DEFAULTS: Readonly<SafeHoldConfig> = Object.freeze({
  maxAgeSec: 60,
  maxFutureSkewSec: 5,
  maxDeviationPct: 2,
  minSources: 1,
  minConfidence: 0.8,
});

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function evaluateSafeHold(input: SafeHoldInput = {}): SafeHoldResult {
  const now = input.now ?? Date.now();
  const hold = (code: SafeHoldCode, detail: string): SafeHoldResult => ({ decision: "HOLD", reasons: [{ code, detail }], checkedAt: now });
  if (!num(now)) return hold("BAD_NOW", "current time is not valid");
  const observations = input.observations === undefined ? [] : input.observations;
  const required = input.required === undefined ? [] : input.required;
  if (!Array.isArray(observations) || !Array.isArray(required) || !required.every((k) => typeof k === "string"))
    return hold("BAD_INPUT", "observations and required must be arrays (required of strings)");
  const cfg: SafeHoldConfig = { ...SAFE_HOLD_DEFAULTS, ...(input.config ?? {}) };
  for (const [k, v] of Object.entries(cfg)) if (!num(v) || v < 0) return hold("BAD_CONFIG", `config.${k} not valid`);
  if (cfg.minConfidence > 1) return hold("BAD_CONFIG", "config.minConfidence above 1");

  const reasons: SafeHoldReason[] = [];
  const byKey = new Map<string, Observation[]>();
  for (const o of observations as unknown[]) {
    const ob = o as Partial<Observation> | null;
    if (!ob || typeof ob.key !== "string") { reasons.push({ code: "MALFORMED", detail: "observation without key" }); continue; }
    const tag = `${ob.key}@${ob.source ?? "?"}`;
    if (!num(ob.value)) { reasons.push({ code: "BAD_VALUE", key: ob.key, detail: `${tag}: value not numeric` }); continue; }
    if (!num(ob.observedAt)) { reasons.push({ code: "NO_TIMESTAMP", key: ob.key, detail: `${tag}: missing time` }); continue; }
    const ageSec = (now - ob.observedAt) / 1000;
    const maxAge = num(ob.maxAgeSec) ? ob.maxAgeSec : cfg.maxAgeSec;
    if (ageSec < -cfg.maxFutureSkewSec) { reasons.push({ code: "FUTURE_TIMESTAMP", key: ob.key, detail: `${tag}: ${(-ageSec).toFixed(1)} s in the future` }); continue; }
    if (ageSec > maxAge) { reasons.push({ code: "STALE", key: ob.key, detail: `${tag}: ${ageSec.toFixed(1)} s old (max ${maxAge})` }); continue; }
    if (ob.confidence !== undefined && ob.confidence !== null && !(num(ob.confidence) && ob.confidence >= 0 && ob.confidence <= 1)) {
      reasons.push({ code: "BAD_VALUE", key: ob.key, detail: `${tag}: confidence not valid` }); continue;
    }
    if (num(ob.confidence) && ob.confidence < cfg.minConfidence) {
      reasons.push({ code: "LOW_CONFIDENCE", key: ob.key, detail: `${tag}: confidence ${ob.confidence} < ${cfg.minConfidence}` }); continue;
    }
    const list = byKey.get(ob.key) ?? [];
    list.push(ob as Observation);
    byKey.set(ob.key, list);
  }

  for (const key of required) {
    const sources = new Set((byKey.get(key) ?? []).map((o) => o.source ?? "?"));
    if (sources.size === 0) reasons.push({ code: "MISSING", key, detail: `${key}: no fresh valid data` });
    else if (sources.size < cfg.minSources) reasons.push({ code: "TOO_FEW_SOURCES", key, detail: `${key}: ${sources.size} of ${cfg.minSources} sources` });
  }

  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const vals = list.map((o) => o.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const mid = (min + max) / 2;
    const devPct = mid === 0 ? (max === min ? 0 : Infinity) : ((max - min) / Math.abs(mid)) * 100;
    if (devPct > cfg.maxDeviationPct) reasons.push({ code: "SOURCES_DISAGREE", key, detail: `${key}: sources disagree by ${devPct.toFixed(2)}% (max ${cfg.maxDeviationPct}%)` });
  }

  return { decision: reasons.length ? "HOLD" : "PROCEED", reasons, checkedAt: now };
}

export interface GuardContext {
  planId: `0x${string}`;
  amount: bigint;
  onEvent?: (e: QueueEvent) => void;
}

/**
 * Runs `action` only if SAFE HOLD says PROCEED. Otherwise it does not call it and emits one
 * `blocked` QueueEvent with reason "SafeHold:<CODE>,<CODE>". If the check itself throws -> HOLD.
 * A missing/invalid planId or amount is itself a HOLD (BAD_INPUT): nothing runs without a plan.
 */
export async function guardWithSafeHold<T>(
  input: SafeHoldInput,
  action: () => T | Promise<T>,
  ctx: GuardContext,
): Promise<SafeHoldResult & { executed: boolean; result?: T }> {
  let res: SafeHoldResult;
  const planOk = !!ctx && typeof ctx.planId === "string" && /^0x[0-9a-fA-F]{64}$/.test(ctx.planId) && typeof ctx.amount === "bigint" && ctx.amount >= 0n;
  try {
    res = planOk ? evaluateSafeHold(input) : { decision: "HOLD", reasons: [{ code: "BAD_INPUT", detail: "planId (32 bytes hex) and amount (bigint >= 0) required" }], checkedAt: input?.now ?? Date.now() };
  } catch (e) {
    res = { decision: "HOLD", reasons: [{ code: "CHECK_ERROR", detail: String((e as Error)?.message ?? e) }], checkedAt: input?.now ?? Date.now() };
  }
  if (res.decision !== "PROCEED") {
    const ts = num(res.checkedAt) ? new Date(res.checkedAt).toISOString() : new Date().toISOString();
    ctx?.onEvent?.({
      kind: "blocked",
      planId: (planOk ? ctx.planId.toLowerCase() : `0x${"0".repeat(64)}`) as `0x${string}`,
      reason: `SafeHold:${[...new Set(res.reasons.map((r) => r.code))].join(",")}`,
      amount: typeof ctx?.amount === "bigint" ? ctx.amount : 0n,
      ts,
      id: null,
    });
    return { ...res, executed: false };
  }
  return { ...res, executed: true, result: await action() };
}
