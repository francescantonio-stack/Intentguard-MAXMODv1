import { describe, expect, it } from "vitest";
import { BudgetTree, BudgetTreeBlocked, type BudgetConfigEvent } from "../src/budgetTree";
import type { QueueEvent } from "../src/events";

const U = 1_000_000n; // 1 USDC
const DAY = 86_400_000;
const P = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as `0x${string}`;
let pc = 0;
const np = () => P(++pc);
function setup(cap = 10n * U) {
  let t = 1_800_000_000_000;
  const events: QueueEvent[] = [];
  const cfgEv: BudgetConfigEvent[] = [];
  const b = new BudgetTree("user", "USDC", cap, { now: () => t, onEvent: (e) => events.push(e), onConfig: (e) => cfgEv.push(e) });
  return { b, events, cfgEv, tick: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}
const reasonOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as BudgetTreeBlocked).reason ?? (e as Error).message; } return "no-throw"; };

describe("BudgetTree", () => {
  it("children caps never exceed the parent", () => {
    const { b, events } = setup();
    b.allocate("user", "agentA", 6n * U);
    b.allocate("user", "agentB", 4n * U);
    expect(reasonOf(() => b.allocate("user", "agentC", 1n))).toBe("OverParentCap");
    expect(events.at(-1)).toMatchObject({ kind: "blocked", reason: "OverParentCap", id: "agentC", amount: 1n });
  });

  it("a child cannot spend over its own cap in 24 h", () => {
    const { b } = setup();
    b.allocate("user", "agentA", 3n * U);
    b.spend("agentA", "USDC", 2n * U, np());
    expect(b.canSpend("agentA", "USDC", 2n * U, np())).toEqual({ ok: false, reason: "OverBudget" });
    expect(reasonOf(() => b.spend("agentA", "USDC", 2n * U, np()))).toBe("OverBudget");
    b.spend("agentA", "USDC", 1n * U, np());
    expect(b.available("agentA")).toBe(0n);
  });

  it("the 24 h window rolls for children too", () => {
    const { b, tick } = setup();
    b.allocate("user", "agentA", 3n * U);
    b.spend("agentA", "USDC", 3n * U, np());
    tick(DAY - 1);
    expect(b.canSpend("agentA", "USDC", 1n, np()).ok).toBe(false);
    tick(2);
    expect(b.available("agentA")).toBe(3n * U);
  });

  it("parent spends directly only from the unreserved part", () => {
    const { b } = setup();
    b.allocate("user", "agentA", 7n * U);
    expect(b.available("user")).toBe(3n * U);
    expect(reasonOf(() => b.spend("user", "USDC", 4n * U, np()))).toBe("OverBudget");
    b.spend("user", "USDC", 3n * U, np());
    expect(b.available("agentA")).toBe(7n * U);
  });

  it("nested levels: grandchild limited by every ancestor", () => {
    const { b } = setup();
    b.allocate("user", "team", 4n * U);
    b.allocate("team", "bot1", 3n * U);
    expect(reasonOf(() => b.allocate("team", "bot2", 2n * U))).toBe("OverParentCap");
    b.spend("bot1", "USDC", 3n * U, np());
    expect(b.available("team")).toBe(1n * U);
    expect(b.spentInWindow("user")).toBe(3n * U);
  });

  it("remove + re-allocate the same id gets its history back (Primo's case)", () => {
    const { b } = setup(10n * U);
    b.allocate("user", "a", 5n * U);
    b.allocate("user", "b", 5n * U);
    b.spend("a", "USDC", 5n * U, np());
    b.remove("a");
    expect(b.spentInWindow("user")).toBe(5n * U); // orphan spends still in the ancestor
    expect(b.available("user")).toBe(0n);         // not as parent's free money
    b.allocate("user", "a", 5n * U);
    expect(b.available("a")).toBe(0n);
    expect(b.available("b")).toBe(5n * U);        // sibling slot intact
    expect(b.spentInWindow("a")).toBe(5n * U);
  });

  it("removed id cannot come back under another parent inside the window", () => {
    const { b, tick } = setup();
    b.allocate("user", "team", 4n * U);
    b.allocate("user", "a", 2n * U);
    b.spend("a", "USDC", 1n, np());
    b.remove("a");
    expect(reasonOf(() => b.allocate("team", "a", 1n * U))).toBe("IdReusedElsewhere");
    tick(DAY + 1);
    b.allocate("team", "a", 1n * U);
    expect(b.available("a")).toBe(1n * U);
  });

  it("orphan spends block new allocations until they leave the window", () => {
    const { b, tick } = setup(10n * U);
    b.allocate("user", "a", 6n * U);
    b.spend("a", "USDC", 6n * U, np());
    b.remove("a");
    expect(reasonOf(() => b.allocate("user", "x", 5n * U))).toBe("OverParentCap");
    b.allocate("user", "x", 4n * U);
    tick(DAY + 1);
    b.allocate("user", "y", 6n * U);
  });

  it("allocate and grow take the parent's own spends into account", () => {
    const { b } = setup(10n * U);
    b.spend("user", "USDC", 6n * U, np());
    expect(reasonOf(() => b.allocate("user", "a", 5n * U))).toBe("OverParentCap");
    b.allocate("user", "a", 4n * U);
    expect(reasonOf(() => b.resize("a", 5n * U))).toBe("OverParentCap");
  });

  it("resize rules and invalid caps emit blocked", () => {
    const { b, events } = setup();
    b.allocate("user", "a", 4n * U);
    b.allocate("user", "b", 6n * U);
    expect(reasonOf(() => b.resize("a", 5n * U))).toBe("OverParentCap");
    b.resize("b", 5n * U);
    b.resize("a", 5n * U);
    b.allocate("a", "a1", 2n * U);
    expect(reasonOf(() => b.resize("a", 1n * U))).toBe("BelowChildrenReserve");
    expect(reasonOf(() => b.resize("a", -1n))).toBe("BadCap");
    expect(reasonOf(() => b.allocate("user", "z", 1 as unknown as bigint))).toBe("BadCap");
    expect(events.filter((e) => e.kind === "blocked").map((e) => e.reason)).toEqual(["OverParentCap", "BelowChildrenReserve", "BadCap", "BadCap"]);
  });

  it("shrinking below what was already spent blocks further spending", () => {
    const { b } = setup();
    b.allocate("user", "a", 5n * U);
    b.spend("a", "USDC", 4n * U, np());
    b.resize("a", 4n * U);
    expect(b.available("a")).toBe(0n);
    expect(reasonOf(() => b.resize("a", 3n * U))).toBe("BelowChildrenReserve");
  });

  it("clock not finite or going backwards -> BadNow, nothing written", () => {
    const { b, events, set, tick } = setup();
    b.allocate("user", "a", 5n * U);
    b.spend("a", "USDC", 1n, np());
    tick(-1);
    expect(reasonOf(() => b.spend("a", "USDC", 1n, np()))).toBe("BadNow");
    expect(b.canSpend("a", "USDC", 1n, np())).toEqual({ ok: false, reason: "BadNow" });
    set(Number.NaN);
    expect(reasonOf(() => b.spend("a", "USDC", 1n, np()))).toBe("BadNow");
    expect(reasonOf(() => b.allocate("user", "c", 1n))).toBe("BadNow");
    expect(events.filter((e) => e.kind === "consumed")).toHaveLength(1);
    set(1_800_000_000_000 + 10);
    expect(b.spentInWindow("a")).toBe(1n);
  });

  it("events are QueueEvent: planId, node in id, reason string, amount bigint", () => {
    const { b, events } = setup();
    b.allocate("user", "a", 1n * U);
    const plan = `0x${"AB".repeat(32)}`;
    b.spend("a", "usdc", 1n, plan);
    expect(events.at(-1)).toEqual({ kind: "consumed", planId: plan.toLowerCase(), reason: "", amount: 1n, ts: expect.any(String), id: "a" });
    expect(reasonOf(() => b.spend("a", "USDC", 2n * U, plan))).toBe("OverBudget");
    expect(events.at(-1)).toMatchObject({ kind: "blocked", planId: plan.toLowerCase(), reason: "OverBudget", amount: 2n * U, id: "a" });
    expect(typeof events.at(-1)!.amount).toBe("bigint");
  });

  it("fail-closed on bad input; token case-insensitive", () => {
    const { b } = setup();
    b.allocate("user", "a", 2n * U);
    const ok = np();
    expect(b.canSpend("a", "usdc", 1n, ok).ok).toBe(true);
    expect(b.canSpend("a", "USDC", 0n, ok).reason).toBe("BadAmount");
    expect(b.canSpend("a", "USDC", -1n, ok).reason).toBe("BadAmount");
    expect(b.canSpend("a", "USDC", Number.NaN as unknown as bigint, ok).reason).toBe("BadAmount");
    expect(b.canSpend("a", "WMON", 1n, ok).reason).toBe("WrongToken");
    expect(b.canSpend("ghost", "USDC", 1n, ok).reason).toBe("UnknownBudget");
    expect(b.canSpend("a", "USDC", 1n, "0x12").reason).toBe("BadPlanId");
    expect(reasonOf(() => b.allocate("user", "a", 1n))).toBe("DuplicateId");
    expect(reasonOf(() => b.allocate("ghost", "q", 1n))).toBe("UnknownBudget");
    expect(() => b.remove("user")).toThrow(/root/);
    expect(() => new BudgetTree("u", "USDC", 1n, { windowMs: Number.NaN })).toThrow(/windowMs/);
    expect(() => new BudgetTree("u", "USDC", 1n, { windowMs: Infinity })).toThrow(/windowMs/);
    expect(() => new BudgetTree("u", "", 1n)).toThrow(/token/);
  });

  it("old spends are pruned from memory", () => {
    const { b, tick } = setup();
    b.allocate("user", "a", 5n * U);
    for (let i = 0; i < 5; i++) b.spend("a", "USDC", 1n, np());
    tick(DAY + 1);
    expect(b.spentInWindow("user")).toBe(0n);
    expect((b as unknown as { nodes: Map<string, { spends: unknown[] }> }).nodes.get("a")!.spends).toHaveLength(0);
  });

  it("removing a parent after its child keeps the child's spends in the ancestors (Primo's case)", () => {
    const { b, tick } = setup(10n * U);
    b.allocate("user", "team", 6n * U);
    b.allocate("team", "bot", 5n * U);
    b.spend("bot", "USDC", 5n * U, np());
    b.remove("bot");
    b.remove("team");
    expect(b.available("user")).toBe(5n * U);
    expect(reasonOf(() => b.spend("user", "USDC", 6n * U, np()))).toBe("OverBudget");
    // team comes back: its orphan history comes with it, bot still cannot reset its limit
    b.allocate("user", "team", 6n * U);
    expect(b.available("team")).toBe(1n * U);
    b.allocate("team", "bot", 5n * U);
    expect(b.available("bot")).toBe(0n);
    expect(b.spentInWindow("user")).toBe(5n * U);
    tick(DAY + 1);
    expect(b.available("bot")).toBe(5n * U);
  });

  it("remove of root, of a node with children, or unknown -> blocked event", () => {
    const { b, events } = setup();
    b.allocate("user", "team", 6n * U);
    b.allocate("team", "bot", 1n * U);
    expect(reasonOf(() => b.remove("user"))).toBe("CannotRemove");
    expect(reasonOf(() => b.remove("team"))).toBe("CannotRemove");
    expect(reasonOf(() => b.remove("nope"))).toBe("UnknownBudget");
    expect(events.filter((e) => e.kind === "blocked").map((e) => e.reason)).toEqual(["CannotRemove", "CannotRemove", "UnknownBudget"]);
  });

  it("available / spentInWindow of an unknown id -> blocked UnknownBudget event", () => {
    const { b, events } = setup();
    expect(reasonOf(() => b.available("ghost"))).toBe("UnknownBudget");
    expect(reasonOf(() => b.spentInWindow("ghost"))).toBe("UnknownBudget");
    expect(events.map((e) => [e.kind, e.reason, e.id])).toEqual([["blocked", "UnknownBudget", "ghost"], ["blocked", "UnknownBudget", "ghost"]]);
  });
});
