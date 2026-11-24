import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../src/approvalQueue";
import type { QueueEvent } from "../src/events";

const h = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as `0x${string}`;
const USDC = 1_000_000n; // 6 decimals
const H = 3_600_000;
const DAY = 86_400_000;
function setup(extra: Partial<ConstructorParameters<typeof ApprovalQueue>[0]> = {}) {
  let t = 1_800_000_000_000;
  const events: QueueEvent[] = [];
  const q = new ApprovalQueue({ thresholds: { USDC: 2n * USDC }, now: () => t, onEvent: (e) => events.push(e), ...extra });
  return { q, events, tick: (ms: number) => (t += ms) };
}
const pay = (n: number, amount: bigint, token = "USDC") => ({ planId: h(n), token, amount, to: "0x1111111111111111111111111111111111111111" });

describe("ApprovalQueue", () => {
  it("under the threshold: auto-approved, runs once", () => {
    const { q, events } = setup();
    expect(q.submit(pay(1, 1n * USDC)).status).toBe("auto");
    expect(q.canExecute(h(1))).toBe(true);
    q.consume(h(1), 1n * USDC);
    expect(q.canExecute(h(1))).toBe(false);
    expect(() => q.consume(h(1), 1n * USDC)).toThrow(/blocked: Consumed/);
    expect(events.map((e) => e.kind)).toEqual(["auto_approved", "consumed", "blocked"]);
  });

  it("events follow the ActionBlocked shape: planId, reason string, amount bigint", () => {
    const { q, events } = setup();
    q.submit(pay(1, 5n * USDC));
    expect(() => q.consume(h(1), 5n * USDC)).toThrow(/Pending/);
    const e = events.at(-1)!;
    expect(e).toMatchObject({ kind: "blocked", planId: h(1), reason: "Pending", amount: 5n * USDC, id: "q1" });
    expect(typeof e.amount).toBe("bigint");
    expect(events[0]!.reason).toBe("AboveThreshold");
  });

  it("exactly at the threshold is auto, above goes to the queue", () => {
    const { q } = setup();
    expect(q.submit(pay(1, 2n * USDC)).status).toBe("auto");
    const it2 = q.submit(pay(2, 2n * USDC + 1n));
    expect(it2.status).toBe("pending");
    expect(q.canExecute(h(2))).toBe(false);
  });

  it("pending: blocked until approved, then runs once", () => {
    const { q, events } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    q.approve(it1.id, "max", h(1));
    expect(q.canExecute(h(1))).toBe(true);
    q.consume(h(1), 5n * USDC);
    expect(events.map((e) => e.kind)).toEqual(["queued", "approved", "consumed"]);
  });

  it("approved decisions expire after the TTL", () => {
    const { q, tick, events } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    tick(30 * 60_000);
    q.approve(it1.id, "max", h(1));
    tick(31 * 60_000);
    expect(q.canExecute(h(1))).toBe(false);
    expect(() => q.consume(h(1), 5n * USDC)).toThrow(/blocked: Expired/);
    expect(events.map((e) => e.kind)).toEqual(["queued", "approved", "expired", "blocked"]);
  });

  it("auto decisions expire after the TTL and stop counting in the window", () => {
    const { q, tick } = setup();
    q.submit(pay(1, 2n * USDC));
    expect(q.submit(pay(2, 1n)).status).toBe("pending");
    tick(H + 1);
    expect(() => q.consume(h(1), 2n * USDC)).toThrow(/Expired/);
    expect(q.submit(pay(3, 2n * USDC)).status).toBe("auto"); // unused auto released
  });

  it("anti-splitting: auto-approvals are summed over the window", () => {
    const { q, tick } = setup();
    q.submit(pay(1, 1n * USDC)); q.consume(h(1), 1n * USDC);
    q.submit(pay(2, 1n * USDC)); q.consume(h(2), 1n * USDC);
    const third = q.submit(pay(3, 1n));
    expect(third.status).toBe("pending");
    expect(third.reason).toBe("WindowTotal");
    tick(DAY + 1);
    expect(q.submit(pay(4, 1n * USDC)).status).toBe("auto");
  });

  it("approved payments do not count against the auto window", () => {
    const { q } = setup();
    const big = q.submit(pay(1, 10n * USDC));
    q.approve(big.id, "max", h(1));
    q.consume(h(1), 10n * USDC);
    expect(q.submit(pay(2, 2n * USDC)).status).toBe("auto");
  });

  it("consume with a different amount is blocked and logged with that amount", () => {
    const { q, events } = setup();
    q.submit(pay(1, 1n * USDC));
    expect(() => q.consume(h(1), 3n * USDC)).toThrow(/AmountMismatch/);
    expect(events.at(-1)).toMatchObject({ reason: "AmountMismatch", amount: 3n * USDC });
    expect(q.canExecute(h(1))).toBe(true);
  });

  it("consume without amount is blocked with MissingAmount and stays runnable", () => {
    const { q, events } = setup();
    q.submit(pay(1, 1n * USDC));
    expect(() => (q.consume as (p: string, a?: bigint) => unknown)(h(1))).toThrow(/MissingAmount/);
    expect(() => q.consume(h(1), 1 as unknown as bigint)).toThrow(/MissingAmount/);
    expect(events.at(-1)).toMatchObject({ kind: "blocked", reason: "MissingAmount", amount: 1n * USDC, id: "q1" });
    expect(q.canExecute(h(1))).toBe(true);
    q.consume(h(1), 1n * USDC);
  });

  it("unknown plan is blocked with the given amount, not 0", () => {
    const { q, events } = setup();
    expect(() => q.consume(h(42), 7n)).toThrow(/NotInQueue/);
    expect(events.at(-1)).toMatchObject({ kind: "blocked", reason: "NotInQueue", amount: 7n, id: null });
  });

  it("approval is bound to the exact plan", () => {
    const { q } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    expect(() => q.approve(it1.id, "max", h(99))).toThrow(/planId mismatch/);
    expect(q.canExecute(h(1))).toBe(false);
  });

  it("expired pending cannot be approved or run", () => {
    const { q, tick } = setup({ ttlMs: 60_000 });
    const it1 = q.submit(pay(1, 5n * USDC));
    tick(60_001);
    expect(() => q.approve(it1.id, "max", h(1))).toThrow(/status expired/);
    expect(q.pending()).toEqual([]);
  });

  it("rejected stays blocked, no double decision", () => {
    const { q } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    q.reject(it1.id, "max", "unknown recipient");
    expect(() => q.consume(h(1), 5n * USDC)).toThrow(/Rejected/);
    expect(() => q.approve(it1.id, "max", h(1))).toThrow(/status rejected/);
  });

  it("only listed approvers count, case-insensitive", () => {
    const { q } = setup({ approvers: ["Max"] });
    const it1 = q.submit(pay(1, 5n * USDC));
    expect(() => q.approve(it1.id, "agent", h(1))).toThrow(/approver not allowed/);
    expect(q.approve(it1.id, "MAX", h(1)).decidedBy).toBe("max");
  });

  it("normalizes token to uppercase and planId to lowercase", () => {
    const { q } = setup();
    const upper = `0x${"AB".repeat(32)}` as `0x${string}`;
    const it1 = q.submit({ ...pay(1, 1n, "usdc"), planId: upper });
    expect(it1.status).toBe("auto");
    expect(it1.token).toBe("USDC");
    expect(it1.planId).toBe(upper.toLowerCase());
    expect(q.canExecute(upper)).toBe(true);
    expect(() => q.submit({ ...pay(2, 1n), planId: upper.toLowerCase() as `0x${string}` })).toThrow(/already submitted/);
  });

  it("unknown token: always needs a human (fail-closed)", () => {
    const { q } = setup();
    expect(q.submit(pay(1, 1n, "WMON")).reason).toBe("NoThreshold");
  });

  it("prunes closed items after the window but still blocks replay", () => {
    const { q, tick } = setup();
    for (let i = 1; i <= 50; i++) {
      q.submit(pay(i, 1n));
      q.consume(h(i), 1n);
    }
    const r = q.submit(pay(100, 5n * USDC));
    q.reject(r.id, "max");
    expect(q.size()).toBe(51);
    tick(DAY + 1);
    q.submit(pay(200, 1n));
    expect(q.size()).toBe(1);
    expect(() => q.submit(pay(7, 1n))).toThrow(/already submitted/);
    expect(() => q.consume(h(7), 1n)).toThrow(/blocked: Consumed/);
    expect(() => q.consume(h(100), 5n * USDC)).toThrow(/blocked: Rejected/);
  });

  it("rejects bad input and duplicate plans", () => {
    const { q } = setup();
    expect(() => q.submit(pay(1, 0n))).toThrow(/positive/);
    expect(() => q.submit(pay(1, 1 as unknown as bigint))).toThrow(/positive/);
    expect(() => q.submit({ ...pay(1, 1n), planId: "0x12" as `0x${string}` })).toThrow(/32 bytes/);
    q.submit(pay(1, 1n));
    expect(() => q.submit(pay(1, 1n))).toThrow(/already submitted/);
    expect(() => new ApprovalQueue({ thresholds: { USDC: -1n } })).toThrow(/non-negative/);
    expect(() => new ApprovalQueue({ thresholds: {}, ttlMs: Number.NaN })).toThrow(/ttlMs/);
  });

  it("now() NaN, Infinity or throwing -> blocked BadNow, nothing written", () => {
    for (const bad of [() => Number.NaN, () => Infinity, () => { throw new Error("x"); }, () => "1" as unknown as number]) {
      const events: QueueEvent[] = [];
      const q = new ApprovalQueue({ thresholds: { USDC: 2n * USDC }, now: bad, onEvent: (e) => events.push(e) });
      expect(() => q.submit(pay(1, 1n * USDC))).toThrow("BadNow");
      expect(q.size()).toBe(0);
      expect(events).toEqual([expect.objectContaining({ kind: "blocked", reason: "BadNow", planId: h(1), amount: 1n * USDC })]);
      expect(q.canExecute(h(1))).toBe(false);
    }
  });

  it("clock going backwards (QC case) -> canExecute false, consume blocked BadNow, no write", () => {
    let t = 1_000_000;
    const events: QueueEvent[] = [];
    const q = new ApprovalQueue({ thresholds: { USDC: 2n * USDC }, ttlMs: 1000, now: () => t, onEvent: (e) => events.push(e) });
    q.submit(pay(1, 1n * USDC));
    t = 1_005_000;
    expect(q.canExecute(h(1))).toBe(false); // expired
    t = 1_000_500;
    expect(q.canExecute(h(1))).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "blocked", reason: "BadNow" });
    expect(() => q.consume(h(1), 1n * USDC)).toThrow("BadNow");
    expect(() => q.submit(pay(2, 1n * USDC))).toThrow("BadNow");
    expect(q.size()).toBe(1);
    t = 1_006_000; // clock is fine again: still expired
    expect(q.canExecute(h(1))).toBe(false);
    expect(() => q.consume(h(1), 1n * USDC)).toThrow("Expired");
  });

  it("before expiry, a clock jump back does not make anything runnable again", () => {
    let t = 1_000_000;
    const q = new ApprovalQueue({ thresholds: { USDC: 0n }, ttlMs: 1000, now: () => t });
    q.submit(pay(1, 1n * USDC)); // pending (above threshold)
    t = 1_002_000;
    expect(q.pending()).toEqual([]);
    t = 1_000_100;
    expect(() => q.approve("q1", "0xabc", h(1))).toThrow("BadNow");
  });

  it("blocked events never echo an invalid planId", () => {
    const { q, events } = setup();
    expect(() => q.consume("not-a-plan", 1n)).toThrow("NotInQueue");
    expect(events.at(-1)).toMatchObject({ kind: "blocked", planId: `0x${"0".repeat(64)}`, reason: "NotInQueue", amount: 1n });
    expect(() => q.consume(h(7).toUpperCase().replace("0X", "0x"), 1n)).toThrow("NotInQueue");
    expect(events.at(-1)!.planId).toBe(h(7));
  });

  it("invalid submit or replay -> blocked event (log keeps it), then throw, nothing written", () => {
    const { q, events } = setup();
    const cases: Array<[unknown, string]> = [
      [null, "BadInput"], [{ ...pay(1, 1n), amount: undefined }, "BadAmount"], [{ ...pay(1, 1n), amount: 0n }, "BadAmount"], [{ ...pay(1, 1n), amount: 5 }, "BadAmount"],
      [{ ...pay(1, 1n), planId: null }, "BadPlanId"], [{ ...pay(1, 1n), planId: "0x12" }, "BadPlanId"], [{ ...pay(1, 1n), token: null }, "BadToken"], [{ ...pay(1, 1n), token: " " }, "BadToken"],
    ];
    for (const [req, reason] of cases) {
      expect(() => q.submit(req as never)).toThrow(reason);
      expect(events.at(-1)).toMatchObject({ kind: "blocked", reason, id: null });
    }
    expect(q.size()).toBe(0);
    q.submit(pay(1, 1n * USDC));
    expect(() => q.submit(pay(1, 1n * USDC))).toThrow("Replay");
    expect(events.at(-1)).toMatchObject({ kind: "blocked", reason: "Replay", planId: h(1), amount: 1n * USDC });
    expect(q.size()).toBe(1);
  });

  it("windowMs / ttlMs null or invalid -> constructor error (only undefined takes the default)", () => {
    for (const bad of [{ windowMs: null }, { ttlMs: null }, { ttlMs: 0 }, { windowMs: Number.NaN }]) {
      expect(() => new ApprovalQueue({ thresholds: { USDC: 1n }, ...(bad as object) })).toThrow();
    }
  });
});
