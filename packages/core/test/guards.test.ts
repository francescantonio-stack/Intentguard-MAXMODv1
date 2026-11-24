import { describe, expect, it } from "vitest";
import {
  ZERO_PLAN, asAmount, asFiniteNumber, blockedEvent, guardEvent, lowerAddress, lowerPlanId, upperToken,
} from "../src/guards";

const PLAN = "0xAA".padEnd(66, "A");

describe("lowerPlanId / upperToken / asAmount / asFiniteNumber", () => {
  it("lowerPlanId accepts 0x+64 hex (any case) and lowercases; anything else is null", () => {
    expect(lowerPlanId(PLAN)).toBe(PLAN.toLowerCase());
    expect(lowerPlanId(PLAN.toLowerCase())).toBe(PLAN.toLowerCase());
    expect(lowerPlanId("  " + PLAN + "  ")).toBe(PLAN.toLowerCase());
    expect(lowerPlanId("nope")).toBeNull();
    expect(lowerPlanId("0x12")).toBeNull();
    expect(lowerPlanId("AA".padEnd(64, "A"))).toBeNull(); // missing 0x
    expect(lowerPlanId(null)).toBeNull();
    expect(lowerPlanId(1)).toBeNull();
  });

  it("upperToken trims and uppercases; empty or non-string is null", () => {
    expect(upperToken("usdc")).toBe("USDC");
    expect(upperToken("  mon  ")).toBe("MON");
    expect(upperToken("")).toBeNull();
    expect(upperToken("   ")).toBeNull();
    expect(upperToken(1)).toBeNull();
  });

  it("asAmount accepts only bigint >= 0n", () => {
    expect(asAmount(0n)).toBe(0n);
    expect(asAmount(7n)).toBe(7n);
    expect(asAmount(-1n)).toBeNull();
    expect(asAmount(0)).toBeNull();
    expect(asAmount(7)).toBeNull();
    expect(asAmount("7")).toBeNull();
    expect(asAmount(null)).toBeNull();
    expect(asAmount(NaN)).toBeNull();
  });

  it("asFiniteNumber accepts finite numbers and safe bigints; rejects strings, NaN, Inf, -0, huge bigint", () => {
    expect(asFiniteNumber(0)).toBe(0);
    expect(asFiniteNumber(1.5)).toBe(1.5);
    expect(asFiniteNumber(1n)).toBe(1);
    expect(asFiniteNumber(0n)).toBe(0);
    expect(asFiniteNumber("1")).toBeNull();
    expect(asFiniteNumber(NaN)).toBeNull();
    expect(asFiniteNumber(Infinity)).toBeNull();
    expect(asFiniteNumber(-0)).toBeNull();
    expect(asFiniteNumber(2n ** 256n)).toBeNull();
  });

  it("lowerAddress lowercases a 0x+40 address; anything else is null", () => {
    expect(lowerAddress("0xD2fE6a3Ae252D6fb2f604805898177c8FdaAa24B")).toBe("0xd2fe6a3ae252d6fb2f604805898177c8fdaaa24b");
    expect(lowerAddress("0x12")).toBeNull();
    expect(lowerAddress(null)).toBeNull();
  });
});

describe("guardEvent", () => {
  it("builds a blocked event by default, with lowercase planId and bigint amount", () => {
    const e = guardEvent({ planId: PLAN, reason: "SimRevert", amount: 7n, ts: "2026-11-24T05:40:00.000Z", id: null });
    expect(e).toEqual({
      kind: "blocked",
      planId: PLAN.toLowerCase(),
      reason: "SimRevert",
      amount: 7n,
      ts: "2026-11-24T05:40:00.000Z",
      id: null,
    });
  });

  it("is fail-closed: bad planId or non-bigint amount does not throw", () => {
    const e = guardEvent({ planId: "nope", reason: "SimUnavailable", amount: undefined });
    expect(e.kind).toBe("blocked");
    expect(e.planId).toBe(ZERO_PLAN);
    expect(e.amount).toBe(0n);
  });

  it("blockedEvent is guardEvent with kind blocked; now becomes an ISO timestamp", () => {
    const e = blockedEvent({ planId: PLAN, reason: "BadConfig", amount: 1n, now: 0, id: "q1" });
    expect(e.kind).toBe("blocked");
    expect(e.id).toBe("q1");
    expect(e.ts).toBe(new Date(0).toISOString());
  });
});
