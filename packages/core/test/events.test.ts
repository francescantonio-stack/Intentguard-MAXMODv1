import { describe, expect, it } from "vitest";
import { blockedEvent, normalizeAddress, normalizePlanId, normalizeToken } from "../src/events";

const PLAN = "0xAA".padEnd(66, "A");

describe("QueueEvent helpers", () => {
  it("normalizes planId and addresses to lowercase, tokens to uppercase", () => {
    expect(normalizePlanId(PLAN)).toBe(PLAN.toLowerCase());
    expect(normalizeAddress("0xD2fE6a3Ae252D6fb2f604805898177c8FdaAa24B")).toBe("0xd2fe6a3ae252d6fb2f604805898177c8fdaaa24b");
    expect(normalizeToken("usdc")).toBe("USDC");
  });

  it("builds a blocked event with kind, lowercase planId, bigint amount, ts and id", () => {
    const e = blockedEvent({ planId: PLAN, reason: "SimRevert", amount: 7n, ts: "2026-11-24T05:40:00.000Z", id: null });
    expect(e).toEqual({
      kind: "blocked",
      planId: PLAN.toLowerCase(),
      reason: "SimRevert",
      amount: 7n,
      ts: "2026-11-24T05:40:00.000Z",
      id: null,
    });
    expect(typeof e.amount).toBe("bigint");
    expect(e.amount).not.toBe(0n);
  });

  it("is fail-closed: bad planId or non-bigint amount does not throw", () => {
    const e = blockedEvent({ planId: "nope", reason: "SimUnavailable", amount: undefined as never });
    expect(e.kind).toBe("blocked");
    expect(e.planId).toBe("0x" + "00".repeat(32));
    expect(e.amount).toBe(0n);
  });
});
