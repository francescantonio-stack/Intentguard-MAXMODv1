import { describe, expect, it } from "vitest";
import { evaluateSafeHold, guardWithSafeHold, type Observation } from "../src/safeHold";
import type { QueueEvent } from "../src/events";

const NOW = 1_800_000_000_000;
const PLAN = `0x${"ab".repeat(32)}` as `0x${string}`;
const obs = (o: Partial<Observation> = {}): Observation => ({ key: "price:MON/USDC", value: 0.5, observedAt: NOW - 10_000, source: "a", ...o });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code).sort();

describe("evaluateSafeHold", () => {
  it("fresh and consistent -> PROCEED", () => {
    const r = evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs(), obs({ source: "b", value: 0.501 })] });
    expect(r.decision).toBe("PROCEED");
    expect(r.reasons).toEqual([]);
  });
  it("stale -> HOLD STALE + MISSING", () => {
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs({ observedAt: NOW - 120_000 })] }))).toEqual(["MISSING", "STALE"]);
  });
  it("source maxAgeSec can only tighten the limit", () => {
    const o = (age: number, maxAgeSec?: number): Observation => ({ key: "policy:nonce", value: 7, observedAt: NOW - age, source: "rpc", ...(maxAgeSec !== undefined ? { maxAgeSec } : {}) });
    expect(codes(evaluateSafeHold({ now: NOW, required: ["policy:nonce"], observations: [o(200_000, 300)] }))).toEqual(["MISSING", "STALE"]);
    expect(evaluateSafeHold({ now: NOW, required: ["policy:nonce"], observations: [o(11 * 86_400_000, 1e9)] }).decision).toBe("HOLD");
    expect(codes(evaluateSafeHold({ now: NOW, required: ["policy:nonce"], observations: [o(10_000, 5)] }))).toEqual(["MISSING", "STALE"]);
    expect(evaluateSafeHold({ now: NOW, required: ["policy:nonce"], config: { maxAgeSec: 300 }, observations: [o(200_000)] }).decision).toBe("PROCEED");
  });
  it("required missing -> HOLD MISSING", () => {
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [] }))).toEqual(["MISSING"]);
  });
  it("future timestamp -> HOLD", () => {
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs({ observedAt: NOW + 60_000 })] }))).toEqual(["FUTURE_TIMESTAMP", "MISSING"]);
  });
  it("sources disagree over 2% -> HOLD", () => {
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs(), obs({ source: "b", value: 0.55 })] }))).toEqual(["SOURCES_DISAGREE"]);
  });
  it("low confidence -> HOLD", () => {
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs({ confidence: 0.3 })] }))).toEqual(["LOW_CONFIDENCE", "MISSING"]);
  });
  it("non-numeric value or missing time -> HOLD", () => {
    const r = evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs({ value: Number.NaN }), obs({ observedAt: undefined as unknown as number })] });
    expect(codes(r)).toEqual(["BAD_VALUE", "MISSING", "NO_TIMESTAMP"]);
  });
  it("too few sources -> HOLD", () => {
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs(), obs()], config: { minSources: 2 } }))).toEqual(["TOO_FEW_SOURCES"]);
  });
  it("non-finite now -> HOLD BAD_NOW", () => {
    expect(codes(evaluateSafeHold({ now: Number.NaN, required: ["price:MON/USDC"], observations: [obs({ observedAt: 0 })] }))).toEqual(["BAD_NOW"]);
  });
  it("confidence non-numeric or outside 0..1 -> HOLD BAD_VALUE", () => {
    for (const c of ["0.1", 1.5, -0.2, Number.NaN]) {
      const r = evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs({ confidence: c as unknown as number })] });
      expect(codes(r)).toEqual(["BAD_VALUE", "MISSING"]);
    }
  });
  it("required empty, missing or not a list -> HOLD NO_REQUIRED", () => {
    for (const required of [[], undefined, 5, "price", [""], [1]]) {
      expect(codes(evaluateSafeHold({ now: NOW, required: required as unknown as string[], observations: [] }))).toEqual(["NO_REQUIRED"]);
    }
  });
  it("bad config -> HOLD BAD_CONFIG", () => {
    const R = ["price:MON/USDC"];
    for (const config of [{ maxAgeSec: Number.NaN }, { maxDeviationPct: Infinity }, { maxAgeSec: 0 }, { maxAgeSec: -1 }, { minSources: 0 }, { minSources: 1.5 }, { minConfidence: 2 }, { maxFutureSkewSec: "5" }]) {
      expect(codes(evaluateSafeHold({ now: NOW, required: R, observations: [obs()], config: config as never }))).toEqual(["BAD_CONFIG"]);
    }
  });
  it("observations null or not a list -> HOLD MALFORMED; null item -> MALFORMED", () => {
    for (const o of [null, 5, "x", {}]) {
      expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: o as unknown as Observation[] }))).toEqual(["MALFORMED"]);
    }
    expect(codes(evaluateSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [null as unknown as Observation, obs()] }))).toEqual(["MALFORMED"]);
  });
});

describe("guardWithSafeHold", () => {
  it("HOLD: action not called, one blocked QueueEvent with planId and bigint amount", async () => {
    let called = 0;
    const ev: QueueEvent[] = [];
    const r = await guardWithSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [] }, () => { called++; }, { planId: PLAN, amount: 1_000_000n, onEvent: (e) => ev.push(e) });
    expect(r.executed).toBe(false);
    expect(called).toBe(0);
    expect(ev).toEqual([{ kind: "blocked", planId: PLAN, reason: "SafeHold:MISSING", amount: 1_000_000n, ts: new Date(NOW).toISOString(), id: null }]);
  });
  it("PROCEED runs the action, no event", async () => {
    const ev: QueueEvent[] = [];
    const r = await guardWithSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs()] }, () => 42, { planId: PLAN, amount: 1n, onEvent: (e) => ev.push(e) });
    expect(r.executed).toBe(true);
    expect(r.result).toBe(42);
    expect(ev).toEqual([]);
  });
  it("missing or invalid plan context -> HOLD BAD_INPUT, action not called", async () => {
    let called = 0;
    for (const ctx of [{ planId: "0x12", amount: 1n }, { planId: PLAN, amount: 1 }, { planId: PLAN, amount: -1n }]) {
      const r = await guardWithSafeHold({ now: NOW, required: ["price:MON/USDC"], observations: [obs()] }, () => { called++; }, ctx as never);
      expect(codes(r)).toEqual(["BAD_INPUT"]);
    }
    expect(called).toBe(0);
  });
  it("planId is lowercased in the event", async () => {
    const ev: QueueEvent[] = [];
    await guardWithSafeHold({ now: NOW, required: ["x"] }, () => 0, { planId: PLAN.toUpperCase().replace("0X", "0x") as `0x${string}`, amount: 0n, onEvent: (e) => ev.push(e) });
    expect(ev[0]!.planId).toBe(PLAN);
  });
});
