import { describe, expect, it } from "vitest";
import { BudgetTree, type BudgetEvent } from "../src/budgetTree";

const U = 1_000_000n; // 1 USDC
function setup(cap = 10n * U) {
  let t = 1_800_000_000_000;
  const events: BudgetEvent[] = [];
  const b = new BudgetTree("user", "USDC", cap, { now: () => t, onEvent: (e) => events.push(e) });
  return { b, events, tick: (ms: number) => (t += ms) };
}

describe("BudgetTree", () => {
  it("children caps never exceed the parent", () => {
    const { b, events } = setup();
    b.allocate("user", "agentA", 6n * U);
    b.allocate("user", "agentB", 4n * U);
    expect(() => b.allocate("user", "agentC", 1n)).toThrow(/exceed parent/);
    expect(events.at(-1)!.kind).toBe("blocked");
  });

  it("a child cannot spend over its own cap in 24 h", () => {
    const { b } = setup();
    b.allocate("user", "agentA", 3n * U);
    b.spend("agentA", "USDC", 2n * U);
    expect(b.canSpend("agentA", "USDC", 2n * U).ok).toBe(false);
    expect(() => b.spend("agentA", "USDC", 2n * U)).toThrow(/over 24h budget/);
    b.spend("agentA", "USDC", 1n * U);
    expect(b.available("agentA")).toBe(0n);
  });

  it("the 24 h window rolls for children too", () => {
    const { b, tick } = setup();
    b.allocate("user", "agentA", 3n * U);
    b.spend("agentA", "USDC", 3n * U);
    tick(86_399_999);
    expect(b.canSpend("agentA", "USDC", 1n).ok).toBe(false);
    tick(2);
    expect(b.available("agentA")).toBe(3n * U);
  });

  it("parent spends directly only from the unreserved part", () => {
    const { b } = setup();
    b.allocate("user", "agentA", 7n * U);
    expect(b.available("user")).toBe(3n * U);
    expect(() => b.spend("user", "USDC", 4n * U)).toThrow(/over 24h/);
    b.spend("user", "USDC", 3n * U);
    // the child's reserve is intact
    expect(b.available("agentA")).toBe(7n * U);
  });

  it("sum of all spending under the parent never exceeds the parent cap", () => {
    const { b } = setup();
    b.allocate("user", "a", 5n * U);
    b.allocate("user", "b", 5n * U);
    b.spend("a", "USDC", 5n * U);
    b.spend("b", "USDC", 5n * U);
    expect(b.spentInWindow("user")).toBe(10n * U);
    expect(b.canSpend("user", "USDC", 1n).ok).toBe(false);
  });

  it("nested levels: grandchild limited by every ancestor", () => {
    const { b } = setup();
    b.allocate("user", "team", 4n * U);
    b.allocate("team", "bot1", 3n * U);
    expect(() => b.allocate("team", "bot2", 2n * U)).toThrow(/exceed parent/);
    b.spend("bot1", "USDC", 3n * U);
    expect(b.available("team")).toBe(1n * U);
    expect(b.spentInWindow("user")).toBe(3n * U);
  });

  it("resize: growing must fit the parent, shrinking must cover grandchildren", () => {
    const { b } = setup();
    b.allocate("user", "a", 4n * U);
    b.allocate("user", "b", 6n * U);
    expect(() => b.resize("a", 5n * U)).toThrow(/exceed parent/);
    b.resize("b", 5n * U);
    b.resize("a", 5n * U);
    b.allocate("a", "a1", 2n * U);
    expect(() => b.resize("a", 1n * U)).toThrow(/children reserve/);
  });

  it("shrinking below what was already spent blocks further spending", () => {
    const { b } = setup();
    b.allocate("user", "a", 5n * U);
    b.spend("a", "USDC", 4n * U);
    b.resize("a", 2n * U);
    expect(b.available("a")).toBe(0n);
  });

  it("remove + re-allocate does not reset the 24 h limit", () => {
    const { b } = setup(5n * U);
    b.allocate("user", "a", 5n * U);
    b.spend("a", "USDC", 5n * U);
    b.remove("a");
    b.allocate("user", "a", 5n * U);
    expect(b.available("a")).toBe(0n);
    expect(b.canSpend("a", "USDC", 1n).ok).toBe(false);
  });

  it("fail-closed on bad input", () => {
    const { b } = setup();
    b.allocate("user", "a", 2n * U);
    expect(b.canSpend("a", "USDC", 0n).ok).toBe(false);
    expect(b.canSpend("a", "USDC", -1n).ok).toBe(false);
    expect(b.canSpend("a", "USDC", Number.NaN as unknown as bigint).ok).toBe(false);
    expect(b.canSpend("a", "USDC", 1 as unknown as bigint).ok).toBe(false);
    expect(b.canSpend("a", "WMON", 1n).ok).toBe(false);
    expect(b.canSpend("ghost", "USDC", 1n).ok).toBe(false);
    expect(() => b.allocate("user", "a", 1n)).toThrow(/duplicate/);
    expect(() => b.allocate("user", "x", -1n)).toThrow(/non-negative/);
    expect(() => b.remove("user")).toThrow(/root/);
    expect(() => new BudgetTree("u", "USDC", 1n, { windowMs: Number.NaN })).toThrow(/windowMs/);
  });

  it("blocked spends are logged and not recorded", () => {
    const { b, events } = setup();
    b.allocate("user", "a", 1n * U);
    expect(() => b.spend("a", "USDC", 2n * U)).toThrow();
    expect(events.at(-1)).toMatchObject({ kind: "blocked", node: "a", amount: "2000000" });
    expect(b.spentInWindow("a")).toBe(0n);
  });
});
