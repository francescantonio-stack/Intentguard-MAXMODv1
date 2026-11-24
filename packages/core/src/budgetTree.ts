/**
 * Child budgets carved from a parent budget (Sumplus idea).
 * - Each child gets a FIXED cap reserved from its parent: children caps + what the parent already spent
 *   outside its children (own spends + spends of removed children) never exceed the parent cap.
 * - Every spend is checked against a rolling window (default 24 h) at the node AND at every ancestor.
 * - The parent may spend directly only from what is not reserved for its children.
 * - Removing a child keeps its spends in the ancestors ("orphan" spends); re-creating the same id under the
 *   same parent gets its history back, so the 24 h limit cannot be reset.
 * - Blocks and spends are reported as the shared QueueEvent; config changes go to `onConfig`.
 * Pure and in-memory: no network, no keys, no signing. Anything invalid is blocked (fail-closed).
 */
import type { QueueEvent } from "./events";

export type BudgetBlockReason =
  | "BadNow" | "BadAmount" | "BadPlanId" | "UnknownBudget" | "WrongToken" | "OverBudget"
  | "BadCap" | "OverParentCap" | "BelowChildrenReserve" | "DuplicateId" | "IdReusedElsewhere" | "CannotRemove"
  | "BadConfig" | "BadToken";

export interface BudgetConfigEvent {
  kind: "allocated" | "resized" | "removed";
  id: string;
  cap: bigint;
  ts: string;
}

interface Spend { at: number; amount: bigint }
interface Node {
  id: string; parent: string | null; cap: bigint; token: string;
  spends: Spend[];      // own spends
  orphans: Spend[];     // spends of removed children (count in this subtree, not as own)
  children: Set<string>;
}

export interface BudgetTreeConfig {
  windowMs?: number; // default 24 h
  now?: () => number;
  onEvent?: (e: QueueEvent) => void;
  onConfig?: (e: BudgetConfigEvent) => void;
}

const ZERO_PLAN = `0x${"0".repeat(64)}` as `0x${string}`;
const PLAN_RE = /^0x[0-9a-fA-F]{64}$/;
const isNonNeg = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n;

export class BudgetTreeBlocked extends Error {
  constructor(public readonly reason: BudgetBlockReason, detail: string) {
    super(`blocked: ${reason}: ${detail}`);
  }
}

export class BudgetTree {
  private nodes = new Map<string, Node>();
  /** removed ids -> parent, own spends and orphans, to give the history back if the id returns */
  private graveyard = new Map<string, { parent: string; spends: Spend[]; orphans: Spend[] }>();
  private readonly windowMs: number;
  private readonly nowFn: () => number;
  private readonly onEvent?: (e: QueueEvent) => void;
  private readonly onConfig?: (e: BudgetConfigEvent) => void;
  private lastNow = -Infinity;

  constructor(rootId: string, token: string, cap: bigint, cfg: BudgetTreeConfig = {}) {
    // sinks first, so a bad constructor input still leaves a `blocked` event in the log before the throw
    const c = (typeof cfg === "object" && cfg !== null ? cfg : {}) as BudgetTreeConfig;
    this.onEvent = typeof c.onEvent === "function" ? c.onEvent : undefined;
    this.onConfig = typeof c.onConfig === "function" ? c.onConfig : undefined;
    this.windowMs = c.windowMs === undefined ? 86_400_000 : (c.windowMs as number); // null/junk is not "missing"
    this.nowFn = typeof c.now === "function" ? c.now : () => Date.now();
    if (cfg !== c) this.block("BadConfig", "config must be an object", null, cap);
    if (c.onEvent !== undefined && typeof c.onEvent !== "function") this.block("BadConfig", "onEvent must be a function", null, cap);
    if (c.onConfig !== undefined && typeof c.onConfig !== "function") this.block("BadConfig", "onConfig must be a function", null, cap);
    if (!(typeof this.windowMs === "number" && Number.isFinite(this.windowMs) && this.windowMs > 0)) this.block("BadConfig", "windowMs must be finite and > 0", null, cap);
    if (c.now !== undefined && typeof c.now !== "function") this.block("BadConfig", "now must be a function", null, cap);
    if (typeof rootId !== "string" || !rootId) this.block("UnknownBudget", "root id required", null, cap);
    if (typeof token !== "string" || !token.trim()) this.block("BadToken", "token required", rootId, cap);
    if (!isNonNeg(cap)) this.block("BadCap", "cap must be a non-negative bigint", rootId, cap);
    this.nodes.set(rootId, { id: rootId, parent: null, cap, token: token.toUpperCase(), spends: [], orphans: [], children: new Set() });
  }

  /** Current time, or null if not finite / went backwards (then everything is blocked). */
  private now(): number | null {
    let t: unknown;
    try { t = this.nowFn(); } catch { return null; }
    if (typeof t !== "number" || !Number.isFinite(t) || t < this.lastNow) return null;
    this.lastNow = t;
    return t;
  }

  private block(reason: BudgetBlockReason, detail: string, node: string | null, amount: unknown, planId?: unknown): never {
    const t = this.lastNow;
    this.onEvent?.({
      kind: "blocked",
      planId: typeof planId === "string" && PLAN_RE.test(planId) ? (planId.toLowerCase() as `0x${string}`) : ZERO_PLAN,
      reason,
      amount: typeof amount === "bigint" ? amount : 0n,
      ts: Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString(),
      id: node,
    });
    throw new BudgetTreeBlocked(reason, detail);
  }

  private nowOrBlock(node: string | null, amount: unknown, planId?: unknown): number {
    const t = this.now();
    if (t === null) return this.block("BadNow", "clock not finite or went backwards", node, amount, planId);
    return t;
  }

  private get(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown budget ${id}`);
    return n;
  }

  /** Drop spends outside the window everywhere (nodes, orphans, graveyard). */
  private prune(now: number): void {
    const from = now - this.windowMs;
    const keep = (l: Spend[]) => l.filter((s) => s.at > from);
    for (const n of this.nodes.values()) { n.spends = keep(n.spends); n.orphans = keep(n.orphans); }
    for (const [id, g] of this.graveyard) {
      g.spends = keep(g.spends);
      g.orphans = keep(g.orphans);
      if (!g.spends.length && !g.orphans.length) this.graveyard.delete(id);
    }
  }

  private sum(l: Spend[]): bigint { return l.reduce((a, s) => a + s.amount, 0n); }
  private reserved(n: Node): bigint { let s = 0n; for (const c of n.children) s += this.get(c).cap; return s; }
  /** Spent by this node outside its live children (own + removed children). */
  private nonChildSpent(n: Node): bigint { return this.sum(n.spends) + this.sum(n.orphans); }
  private subtreeSpent(n: Node): bigint {
    let s = this.nonChildSpent(n);
    for (const c of n.children) s += this.subtreeSpent(this.get(c));
    return s;
  }
  private availableAt(n: Node): bigint {
    let unusedChildReserve = 0n;
    for (const c of n.children) {
      const cn = this.get(c);
      const used = this.subtreeSpent(cn);
      if (cn.cap > used) unusedChildReserve += cn.cap - used;
    }
    let avail = n.cap - this.subtreeSpent(n) - unusedChildReserve;
    for (let p = n.parent; p !== null; p = this.get(p).parent) {
      const pn = this.get(p);
      const room = pn.cap - this.subtreeSpent(pn);
      if (room < avail) avail = room;
    }
    return avail > 0n ? avail : 0n;
  }

  spentInWindow(id: string): bigint {
    const now = this.nowOrBlock(id, 0n);
    this.prune(now);
    if (!this.nodes.has(id)) this.block("UnknownBudget", `unknown budget ${id}`, id, 0n);
    return this.subtreeSpent(this.get(id));
  }

  available(id: string): bigint {
    const now = this.nowOrBlock(id, 0n);
    this.prune(now);
    if (!this.nodes.has(id)) this.block("UnknownBudget", `unknown budget ${id}`, id, 0n);
    return this.availableAt(this.get(id));
  }

  /** Reserve a fixed child budget. Children caps + parent's non-child spends must fit the parent cap. */
  allocate(parentId: string, childId: string, cap: bigint): void {
    const now = this.nowOrBlock(childId, cap);
    this.prune(now);
    if (!isNonNeg(cap)) this.block("BadCap", "cap must be a non-negative bigint", childId, cap);
    if (typeof childId !== "string" || !childId || this.nodes.has(childId)) this.block("DuplicateId", `invalid or duplicate child ${String(childId)}`, childId, cap);
    if (!this.nodes.has(parentId)) this.block("UnknownBudget", `unknown parent ${parentId}`, childId, cap);
    const p = this.get(parentId);
    const ghost = this.graveyard.get(childId);
    if (ghost && ghost.parent !== parentId) this.block("IdReusedElsewhere", `${childId} was under ${ghost.parent} in the window`, childId, cap);
    // the returning history moves from the parent's orphans back to the child
    const back = ghost ? ghost.spends : [];
    const backOrphans = ghost ? ghost.orphans : [];
    const orphansAfter = ghost ? p.orphans.filter((s) => !back.includes(s) && !backOrphans.includes(s)) : p.orphans;
    const nonChildAfter = this.sum(p.spends) + this.sum(orphansAfter);
    const backSum = this.sum(back) + this.sum(backOrphans);
    const childNeed = cap > backSum ? cap : backSum; // a child's slot covers at least its history
    if (this.reserved(p) + childNeed + nonChildAfter > p.cap) this.block("OverParentCap", "children + parent spent would exceed parent cap", childId, cap);
    p.children.add(childId);
    p.orphans = orphansAfter;
    this.graveyard.delete(childId);
    this.nodes.set(childId, { id: childId, parent: parentId, cap, token: p.token, spends: [...back], orphans: [...backOrphans], children: new Set() });
    this.onConfig?.({ kind: "allocated", id: childId, cap, ts: new Date(now).toISOString() });
  }

  /** Change a cap. Growing must fit the parent (incl. its spends); shrinking must still cover its children. */
  resize(id: string, cap: bigint): void {
    const now = this.nowOrBlock(id, cap);
    this.prune(now);
    if (!isNonNeg(cap)) this.block("BadCap", "cap must be a non-negative bigint", id, cap);
    if (!this.nodes.has(id)) this.block("UnknownBudget", `unknown budget ${id}`, id, cap);
    const n = this.get(id);
    if (this.reserved(n) + this.nonChildSpent(n) > cap) this.block("BelowChildrenReserve", "cap below children reserve + own spends", id, cap);
    if (n.parent !== null && cap > n.cap) {
      const p = this.get(n.parent);
      if (this.reserved(p) - n.cap + cap + this.nonChildSpent(p) > p.cap) this.block("OverParentCap", "children + parent spent would exceed parent cap", id, cap);
    }
    n.cap = cap;
    this.onConfig?.({ kind: "resized", id, cap, ts: new Date(now).toISOString() });
  }

  /** Remove a leaf child; its spends stay in the ancestors until they leave the window. */
  remove(id: string): void {
    const now = this.nowOrBlock(id, 0n);
    this.prune(now);
    if (!this.nodes.has(id)) this.block("UnknownBudget", `unknown budget ${id}`, id, 0n);
    const n = this.get(id);
    if (n.parent === null) this.block("CannotRemove", "cannot remove root", id, 0n);
    if (n.children.size) this.block("CannotRemove", "remove children first", id, 0n);
    const p = this.get(n.parent);
    p.children.delete(id);
    this.nodes.delete(id);
    // own spends AND spends of already-removed grandchildren stay in the ancestors
    p.orphans.push(...n.spends, ...n.orphans);
    if (n.spends.length || n.orphans.length) this.graveyard.set(id, { parent: p.id, spends: n.spends, orphans: n.orphans });
    this.onConfig?.({ kind: "removed", id, cap: n.cap, ts: new Date(now).toISOString() });
  }

  private check(id: string, token: string, amount: bigint, planId: string): { ok: true } | { ok: false; reason: BudgetBlockReason; detail: string } {
    if (typeof planId !== "string" || !PLAN_RE.test(planId)) return { ok: false, reason: "BadPlanId", detail: "planId must be 32 bytes hex" };
    if (typeof amount !== "bigint" || amount <= 0n) return { ok: false, reason: "BadAmount", detail: "amount must be a positive bigint" };
    const n = this.nodes.get(id);
    if (!n) return { ok: false, reason: "UnknownBudget", detail: `unknown budget ${id}` };
    if (typeof token !== "string" || n.token !== token.toUpperCase()) return { ok: false, reason: "WrongToken", detail: `budget is ${n.token}` };
    const avail = this.availableAt(n);
    if (amount > avail) return { ok: false, reason: "OverBudget", detail: `asked ${amount}, available ${avail}` };
    return { ok: true };
  }

  /** Read-only check; never writes. A bad clock is a block (not ok). */
  canSpend(id: string, token: string, amount: bigint, planId: string): { ok: boolean; reason?: BudgetBlockReason } {
    const now = this.now();
    if (now === null) return { ok: false, reason: "BadNow" };
    this.prune(now);
    const r = this.check(id, token, amount, planId);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  /** Records the spend only if allowed; otherwise emits one `blocked` QueueEvent and throws. */
  spend(id: string, token: string, amount: bigint, planId: string): void {
    const now = this.nowOrBlock(id, amount, planId);
    this.prune(now);
    const r = this.check(id, token, amount, planId);
    if (!r.ok) this.block(r.reason, r.detail, id, amount, planId);
    this.get(id).spends.push({ at: now, amount });
    this.onEvent?.({ kind: "consumed", planId: planId.toLowerCase() as `0x${string}`, reason: "", amount, ts: new Date(now).toISOString(), id });
  }
}
