import { describe, expect, it } from "vitest";
import { ApprovalQueue, type QueueEvent } from "../src/approvalQueue";

const h = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as `0x${string}`;
const USDC = 1_000_000n; // 6 decimals
function setup(extra: Partial<ConstructorParameters<typeof ApprovalQueue>[0]> = {}) {
  let t = 1_800_000_000_000;
  const events: QueueEvent[] = [];
  const q = new ApprovalQueue({ thresholds: { USDC: 2n * USDC }, now: () => t, onEvent: (e) => events.push(e), ...extra });
  return { q, events, tick: (ms: number) => (t += ms) };
}
const pay = (n: number, amount: bigint, token = "USDC") => ({ planHash: h(n), token, amount, to: "0x1111111111111111111111111111111111111111" });

describe("ApprovalQueue", () => {
  it("under the threshold: auto-approved, runs once", () => {
    const { q, events } = setup();
    expect(q.submit(pay(1, 1n * USDC)).status).toBe("auto");
    expect(q.canExecute(h(1))).toBe(true);
    q.consume(h(1));
    expect(q.canExecute(h(1))).toBe(false);
    expect(() => q.consume(h(1))).toThrow(/blocked: status consumed/);
    expect(events.map((e) => e.kind)).toEqual(["auto_approved", "consumed", "blocked"]);
  });

  it("exactly at the threshold is auto, above goes to the queue", () => {
    const { q } = setup();
    expect(q.submit(pay(1, 2n * USDC)).status).toBe("auto");
    const it2 = q.submit(pay(2, 2n * USDC + 1n));
    expect(it2.status).toBe("pending");
    expect(it2.reason).toBe("above threshold");
    expect(q.canExecute(h(2))).toBe(false);
  });

  it("pending: blocked until approved, then runs once", () => {
    const { q, events } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    expect(() => q.consume(h(1))).toThrow(/status pending/);
    q.approve(it1.id, "max", h(1));
    expect(q.canExecute(h(1))).toBe(true);
    q.consume(h(1));
    expect(events.map((e) => e.kind)).toEqual(["queued", "blocked", "approved", "consumed"]);
    expect(events[0]!.amount).toBe("5000000");
  });

  it("anti-splitting: auto-approvals are summed over the window", () => {
    const { q, tick } = setup();
    expect(q.submit(pay(1, 1n * USDC)).status).toBe("auto");
    expect(q.submit(pay(2, 1n * USDC)).status).toBe("auto");
    const third = q.submit(pay(3, 1n));
    expect(third.status).toBe("pending");
    expect(third.reason).toBe("window total above threshold");
    tick(86_400_001);
    expect(q.submit(pay(4, 1n * USDC)).status).toBe("auto");
  });

  it("approved payments do not count against the auto window", () => {
    const { q } = setup();
    const big = q.submit(pay(1, 10n * USDC));
    q.approve(big.id, "max", h(1));
    q.consume(h(1));
    expect(q.submit(pay(2, 2n * USDC)).status).toBe("auto");
  });

  it("approval is bound to the exact plan", () => {
    const { q } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    expect(() => q.approve(it1.id, "max", h(99))).toThrow(/planHash mismatch/);
    expect(q.canExecute(h(1))).toBe(false);
  });

  it("expired requests cannot be approved or run", () => {
    const { q, tick, events } = setup({ ttlMs: 60_000 });
    const it1 = q.submit(pay(1, 5n * USDC));
    tick(60_001);
    expect(() => q.approve(it1.id, "max", h(1))).toThrow(/status expired/);
    expect(q.canExecute(h(1))).toBe(false);
    expect(events.some((e) => e.kind === "expired")).toBe(true);
    expect(q.pending()).toEqual([]);
  });

  it("rejected stays blocked, no double decision", () => {
    const { q } = setup();
    const it1 = q.submit(pay(1, 5n * USDC));
    q.reject(it1.id, "max", "unknown recipient");
    expect(q.canExecute(h(1))).toBe(false);
    expect(() => q.approve(it1.id, "max", h(1))).toThrow(/status rejected/);
  });

  it("only listed approvers count", () => {
    const { q } = setup({ approvers: ["max"] });
    const it1 = q.submit(pay(1, 5n * USDC));
    expect(() => q.approve(it1.id, "agent", h(1))).toThrow(/approver not allowed/);
    expect(q.approve(it1.id, "max", h(1)).status).toBe("approved");
  });

  it("unknown token: always needs a human (fail-closed)", () => {
    const { q } = setup();
    const it1 = q.submit(pay(1, 1n, "WMON"));
    expect(it1.status).toBe("pending");
    expect(it1.reason).toBe("no threshold for token");
  });

  it("rejects bad input and duplicate plans; unknown plan is blocked", () => {
    const { q } = setup();
    expect(() => q.submit(pay(1, 0n))).toThrow(/positive/);
    expect(() => q.submit({ ...pay(1, 1n), planHash: "0x12" as `0x${string}` })).toThrow(/32 bytes/);
    q.submit(pay(1, 1n));
    expect(() => q.submit(pay(1, 1n))).toThrow(/already submitted/);
    expect(() => q.consume(h(42))).toThrow(/not in queue/);
  });
});
