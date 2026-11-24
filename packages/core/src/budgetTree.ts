/**
 * Child budgets carved from a parent budget (Sumplus idea).
 * - Each child gets a FIXED cap reserved from its parent: the sum of children caps never exceeds the parent cap.
 * - Every spend is checked against a rolling 24 h window at the node AND at every ancestor.
 * - The parent may spend directly only from what is not reserved for its children.
 * Pure and in-memory: no network, no keys, no signing. Anything invalid is blocked (fail-closed).
 */
export interface BudgetEvent {
  ts: string;
  kind: "spent" | "blocked" | "allocated" | "resized" | "removed";
  node: string;
  amount: string;
  reason?: string;
}

interface Spend { at: number; amount: bigint }
interface Node { id: string; parent: string | null; cap: bigint; token: string; spends: Spend[]; children: Set<string> }

export interface BudgetTreeConfig {
  windowMs?: number; // default 24 h
  now?: () => number;
  onEvent?: (e: BudgetEvent) => void;
}

const isPos = (x: unknown): x is bigint => typeof x === "bigint" && x > 0n;
const isNonNeg = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n;

export class BudgetTree {
  private nodes = new Map<string, Node>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (e: BudgetEvent) => void;

  constructor(rootId: string, token: string, cap: bigint, cfg: BudgetTreeConfig = {}) {
    if (!rootId || !token) throw new Error("root id and token required");
    if (!isNonNeg(cap)) throw new Error("cap must be a non-negative bigint");
    this.windowMs = cfg.windowMs ?? 86_400_000;
    if (!(Number.isFinite(this.windowMs) && this.windowMs > 0)) throw new Error("windowMs must be > 0");
    this.now = cfg.now ?? (() => Date.now());
    this.onEvent = cfg.onEvent;
    this.nodes.set(rootId, { id: rootId, parent: null, cap, token, spends: [], children: new Set() });
  }

  private emit(kind: BudgetEvent["kind"], node: string, amount: bigint, reason?: string) {
    this.onEvent?.({ ts: new Date(this.now()).toISOString(), kind, node, amount: amount.toString(), ...(reason ? { reason } : {}) });
  }
  private get(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown budget ${id}`);
    return n;
  }
  private reserved(n: Node): bigint {
    let s = 0n;
    for (const c of n.children) s += this.get(c).cap;
    return s;
  }
  /** Spent in the window by this node only. */
  private ownSpent(n: Node, now: number): bigint {
    const from = now - this.windowMs;
    let s = 0n;
    for (const sp of n.spends) if (sp.at > from && sp.at <= now) s += sp.amount;
    return s;
  }
  /** Spent in the window by this node and all descendants. */
  spentInWindow(id: string): bigint {
    const now = this.now();
    const walk = (n: Node): bigint => [...n.children].reduce((a, c) => a + walk(this.get(c)), this.ownSpent(n, now));
    return walk(this.get(id));
  }
  /** What `id` can still spend right now, given its cap, its own reserve rule and every ancestor. */
  available(id: string): bigint {
    const n = this.get(id);
    // own cap minus everything spent under it, minus what is reserved for its children but not yet used by them
    let unusedChildReserve = 0n;
    for (const c of n.children) {
      const cn = this.get(c);
      const used = this.spentInWindow(c);
      if (cn.cap > used) unusedChildReserve += cn.cap - used;
    }
    let avail = n.cap - this.spentInWindow(id) - unusedChildReserve;
    for (let p = n.parent; p !== null; p = this.get(p).parent) {
      const pn = this.get(p);
      const room = pn.cap - this.spentInWindow(p);
      if (room < avail) avail = room;
    }
    return avail > 0n ? avail : 0n;
  }

  /** Reserve a fixed child budget from `parentId`. Fails if children would exceed the parent cap. */
  allocate(parentId: string, childId: string, cap: bigint): void {
    if (!childId || this.nodes.has(childId)) throw new Error(`invalid or duplicate child ${childId}`);
    if (!isNonNeg(cap)) throw new Error("cap must be a non-negative bigint");
    const p = this.get(parentId);
    if (this.reserved(p) + cap > p.cap) {
      this.emit("blocked", childId, cap, "children would exceed parent cap");
      throw new Error("children would exceed parent cap");
    }
    p.children.add(childId);
    this.nodes.set(childId, { id: childId, parent: parentId, cap, token: p.token, spends: [], children: new Set() });
    this.emit("allocated", childId, cap);
  }

  /** Change a child cap. Growing must still fit the parent; shrinking must still cover its own children. */
  resize(id: string, cap: bigint): void {
    if (!isNonNeg(cap)) throw new Error("cap must be a non-negative bigint");
    const n = this.get(id);
    if (this.reserved(n) > cap) throw new Error("cap below children reserve");
    if (n.parent !== null) {
      const p = this.get(n.parent);
      if (this.reserved(p) - n.cap + cap > p.cap) {
        this.emit("blocked", id, cap, "children would exceed parent cap");
        throw new Error("children would exceed parent cap");
      }
    }
    n.cap = cap;
    this.emit("resized", id, cap);
  }

  /** Remove a leaf child; its past spends keep counting against ancestors until they leave the window. */
  remove(id: string): void {
    const n = this.get(id);
    if (n.parent === null) throw new Error("cannot remove root");
    if (n.children.size) throw new Error("remove children first");
    const p = this.get(n.parent);
    p.children.delete(id);
    this.nodes.delete(id);
    // keep history on the parent so the 24 h limit cannot be reset by remove + re-allocate
    p.spends.push(...n.spends);
    this.emit("removed", id, n.cap);
  }

  canSpend(id: string, token: string, amount: bigint): { ok: boolean; reason?: string } {
    if (!isPos(amount)) return { ok: false, reason: "amount must be a positive bigint" };
    const n = this.nodes.get(id);
    if (!n) return { ok: false, reason: "unknown budget" };
    if (n.token !== token) return { ok: false, reason: `wrong token ${token}, budget is ${n.token}` };
    const avail = this.available(id);
    if (amount > avail) return { ok: false, reason: `over 24h budget: asked ${amount}, available ${avail}` };
    return { ok: true };
  }

  /** Records the spend only if allowed; otherwise logs a block and throws. */
  spend(id: string, token: string, amount: bigint): void {
    const r = this.canSpend(id, token, amount);
    if (!r.ok) {
      this.emit("blocked", id, typeof amount === "bigint" ? amount : 0n, r.reason);
      throw new Error(`blocked: ${r.reason}`);
    }
    this.get(id).spends.push({ at: this.now(), amount });
    this.emit("spent", id, amount);
  }
}
