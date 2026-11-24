/**
 * Approval queue (Rienda idea): payments above a threshold wait for an explicit human approval.
 * Pure and in-memory: no network, no keys, no signing. The executor must call `canExecute`/`consume`
 * before running a plan; anything not auto-approved or approved stays blocked (fail-closed).
 *
 * Anti-splitting: auto-approvals are summed over a rolling window, so ten payments of 0.9 cannot
 * slip under a threshold of 1.
 * Every decision (auto, approved) expires after `ttlMs`, like pending items.
 * Normalization: token UPPERCASE, planId and approvers lowercase.
 */
import type { QueueEvent } from "./events";

export type QueueStatus = "auto" | "pending" | "approved" | "rejected" | "expired" | "consumed";

/** Queue block reasons, aligned with ActionBlocked(planId, reason, amount). Local to the queue; shared vocabulary lives in events.ts. */
export type QueueBlockReason = "NotInQueue" | "Pending" | "Consumed" | "Expired" | "Rejected" | "AmountMismatch" | "MissingAmount" | "BadNow" | "BadInput" | "BadAmount" | "BadPlanId" | "BadToken" | "Replay" | "BadConfig";

/** Caps fixed by the review: a value too large is a config error, never accepted silently. */
export const MAX_TTL_MS = 86_400_000; // 24 h
export const MAX_WINDOW_MS = 604_800_000; // 7 days


export interface PaymentRequest {
  planId: `0x${string}`;
  token: string;
  amount: bigint; // base units
  to: string;
  summary?: string;
}

export interface QueueItem extends PaymentRequest {
  id: string;
  status: QueueStatus;
  autoApproved: boolean;
  createdAt: number; // ms
  expiresAt: number; // ms
  decidedBy?: string;
  reason?: string;
}

export interface ApprovalQueueConfig {
  /** Per token: amounts strictly above this need a human. */
  thresholds: Record<string, bigint>;
  /** Window for summing auto-approvals (anti-splitting) and for keeping closed items. Default 24 h, max 7 days. */
  windowMs?: number;
  /** How long an item (pending, auto or approved) stays valid. Default 1 h, max 24 h. */
  ttlMs?: number;
  /** If set, only these approvers count. */
  approvers?: string[];
  now?: () => number;
  onEvent?: (e: QueueEvent) => void;
}

const PLAN_RE = /^0x[0-9a-f]{64}$/;
const ZERO_PLAN = `0x${"0".repeat(64)}` as `0x${string}`;
/** planId for events: lowercase if valid 32-byte hex, else the zero plan (never echo junk). */
const evPlan = (p: unknown): `0x${string}` => {
  const s = typeof p === "string" ? p.trim().toLowerCase() : "";
  return PLAN_RE.test(s) ? (s as `0x${string}`) : ZERO_PLAN;
};
const CLOSED: ReadonlySet<QueueStatus> = new Set(["expired", "rejected", "consumed"]);
const BLOCK_OF: Record<QueueStatus, QueueBlockReason> = {
  pending: "Pending", consumed: "Consumed", expired: "Expired", rejected: "Rejected",
  auto: "NotInQueue", approved: "NotInQueue", // never used for blocks of runnable items
};

export class ApprovalQueue {
  private items = new Map<string, QueueItem>();
  private byPlan = new Map<string, string>();
  /** planIds of pruned items -> final status. Kept forever to block replay. */
  private seen = new Map<string, QueueStatus>();
  private seq = 0;
  private readonly thresholds = new Map<string, bigint>();
  private readonly approvers?: Set<string>;
  private readonly windowMs: number = 86_400_000;
  private readonly ttlMs: number = 3_600_000;
  private readonly now: () => number = () => Date.now();
  private readonly onEvent?: (e: QueueEvent) => void;
  /** Bad config: the queue is dead and never authorises anything (fail-closed). */
  private readonly dead: boolean = false;
  /** time of the current operation (checked once per public call) */
  private t = 0;
  private lastNow = -Infinity;

  /** Never throws: bad config emits one blocked BadConfig event and leaves a dead queue. */
  constructor(cfg: ApprovalQueueConfig) {
    const c = (typeof cfg === "object" && cfg !== null ? cfg : {}) as Partial<ApprovalQueueConfig>;
    let onEvent: unknown;
    try { onEvent = c.onEvent; } catch { onEvent = null; }
    if (typeof onEvent === "function") this.onEvent = onEvent as (e: QueueEvent) => void;
    try {
      if (typeof cfg !== "object" || cfg === null) throw new Error("cfg");
      if (onEvent !== undefined && typeof onEvent !== "function") throw new Error("onEvent");
      // only `undefined` takes the default: null, junk or above the cap is a config error
      const windowMs = c.windowMs === undefined ? 86_400_000 : c.windowMs;
      const ttlMs = c.ttlMs === undefined ? 3_600_000 : c.ttlMs;
      if (!(typeof windowMs === "number" && Number.isFinite(windowMs) && windowMs > 0 && windowMs <= MAX_WINDOW_MS)) throw new Error("windowMs");
      if (!(typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 && ttlMs <= MAX_TTL_MS)) throw new Error("ttlMs");
      const th = c.thresholds;
      if (typeof th !== "object" || th === null || Array.isArray(th)) throw new Error("thresholds");
      const thresholds = new Map<string, bigint>();
      for (const [k, v] of Object.entries(th)) {
        if (typeof v !== "bigint" || v < 0n) throw new Error("threshold");
        thresholds.set(k.trim().toUpperCase(), v);
      }
      let approvers: Set<string> | undefined;
      if (c.approvers !== undefined) {
        if (!Array.isArray(c.approvers) || !c.approvers.every((a) => typeof a === "string")) throw new Error("approvers");
        approvers = new Set(c.approvers.map((a) => a.toLowerCase()));
      }
      if (c.now !== undefined && typeof c.now !== "function") throw new Error("now");
      this.windowMs = windowMs;
      this.ttlMs = ttlMs;
      this.thresholds = thresholds;
      this.approvers = approvers;
      if (c.now) this.now = c.now;
    } catch {
      this.dead = true;
      this.emit("blocked", null, 0n, null, "BadConfig");
    }
  }

  /** Dead queue: one blocked BadConfig event per call. */
  private deadBlock(planId: unknown, amount: unknown, id: string | null): boolean {
    if (!this.dead) return false;
    this.emit("blocked", planId, amount, id, "BadConfig");
    return true;
  }

  private throwIfDead(planId: unknown, amount: unknown, id: string | null): void {
    if (this.deadBlock(planId, amount, id)) throw new Error("blocked: BadConfig");
  }

  private emit(kind: QueueEvent["kind"], planId: unknown, amount: unknown, id: string | null, reason = "") {
    const ts = new Date(Number.isFinite(this.lastNow) ? this.lastNow : 0).toISOString();
    this.onEvent?.({ kind, planId: evPlan(planId), reason, amount: typeof amount === "bigint" ? amount : 0n, ts, id });
  }

  /** Reads the clock once: must be a finite number and never go backwards. */
  private clock(): boolean {
    let v: unknown;
    try { v = this.now(); } catch { return false; }
    if (typeof v !== "number" || !Number.isFinite(v) || v < this.lastNow) return false;
    this.lastNow = v;
    this.t = v;
    return true;
  }

  /** Bad clock: one blocked BadNow event, nothing written. */
  private tickOrBlock(planId: unknown, amount: unknown, id: string | null): void {
    if (this.clock()) return;
    this.emit("blocked", planId, amount, id, "BadNow");
    throw new Error("blocked: BadNow");
  }

  private checkApprover(approver: string): string {
    const a = String(approver ?? "").toLowerCase();
    if (!a || (this.approvers && !this.approvers.has(a))) throw new Error("approver not allowed");
    return a;
  }

  /** Drop closed items older than the window; remember their planId to block replay. */
  private prune(): void {
    const from = this.t - this.windowMs;
    for (const [id, it] of this.items) {
      if (it.createdAt < from) this.live(id); // let stale runnable/pending items expire first
      if (CLOSED.has(it.status) && it.createdAt < from) {
        this.items.delete(id);
        this.byPlan.delete(it.planId);
        this.seen.set(it.planId, it.status);
      }
    }
  }

  /** Sum of auto-approved amounts for `token` inside the window (live auto + consumed auto). */
  autoSpent(token: string): bigint {
    this.throwIfDead(null, 0n, null);
    this.tickOrBlock(null, 0n, null);
    return this.autoSpentNow(token);
  }

  private autoSpentNow(token: string): bigint {
    const t = String(token).toUpperCase();
    const from = this.t - this.windowMs;
    let s = 0n;
    for (const id of this.items.keys()) {
      const it = this.live(id);
      if (it.token === t && it.autoApproved && it.createdAt >= from && (it.status === "auto" || it.status === "consumed")) s += it.amount;
    }
    return s;
  }

  /**
   * Never throws. Any block (BadConfig, BadInput, BadAmount, BadPlanId, BadToken, BadNow, Replay)
   * emits exactly one `blocked` event (the log keeps it) and returns null; nothing is written.
   */
  submit(req: PaymentRequest): QueueItem | null {
    let r: Partial<PaymentRequest> = {};
    let isObj = false;
    try {
      isObj = typeof req === "object" && req !== null;
      if (isObj) r = { ...req }; // one snapshot: getters are read once
    } catch { isObj = false; r = {}; }
    const amt: unknown = r.amount;
    const bad = (reason: QueueBlockReason, planId: unknown = r.planId): null => {
      this.emit("blocked", planId, amt, null, reason);
      return null;
    };
    if (this.dead) return bad("BadConfig");
    if (!isObj) return bad("BadInput");
    if (typeof amt !== "bigint" || amt <= 0n) return bad("BadAmount");
    const planId = typeof r.planId === "string" ? r.planId.trim().toLowerCase() : "";
    if (!PLAN_RE.test(planId)) return bad("BadPlanId");
    const token = typeof r.token === "string" ? r.token.trim().toUpperCase() : "";
    if (!token) return bad("BadToken");
    if (!this.clock()) return bad("BadNow", planId); // before ANY write
    this.prune();
    if (this.byPlan.has(planId) || this.seen.has(planId)) return bad("Replay", planId);
    const threshold = this.thresholds.get(token);
    const now = this.t;
    const id = `q${++this.seq}`;
    // Unknown token: no threshold configured -> always a human (fail-closed).
    const auto = threshold !== undefined && this.autoSpentNow(token) + amt <= threshold;
    const it: QueueItem = {
      ...(r as PaymentRequest), amount: amt, planId: planId as `0x${string}`, token, id,
      status: auto ? "auto" : "pending", autoApproved: auto, createdAt: now, expiresAt: now + this.ttlMs,
    };
    if (!auto) it.reason = threshold === undefined ? "NoThreshold" : amt > threshold ? "AboveThreshold" : "WindowTotal";
    this.items.set(id, it);
    this.byPlan.set(planId, id);
    this.emit(auto ? "auto_approved" : "queued", planId, it.amount, id, it.reason);
    return { ...it };
  }

  /** Expires pending, auto and approved items past their TTL. */
  private live(id: string): QueueItem {
    const it = this.items.get(id);
    if (!it) throw new Error(`unknown item ${id}`);
    if ((it.status === "pending" || it.status === "auto" || it.status === "approved") && this.t > it.expiresAt) {
      it.status = "expired";
      this.emit("expired", it.planId, it.amount, it.id);
    }
    return it;
  }

  /** Approval is bound to the exact plan: `planId` must match what was queued. */
  approve(id: string, approver: string, planId: string): QueueItem {
    this.throwIfDead(planId, 0n, typeof id === "string" ? id : null);
    this.tickOrBlock(planId, 0n, typeof id === "string" ? id : null);
    const it = this.live(id);
    const a = this.checkApprover(approver);
    if (it.planId !== String(planId).toLowerCase()) throw new Error("planId mismatch: approval is for a different plan");
    if (it.status !== "pending") throw new Error(`cannot approve: status ${it.status}`);
    it.status = "approved";
    it.decidedBy = a;
    this.emit("approved", it.planId, it.amount, it.id);
    return { ...it };
  }

  reject(id: string, approver: string, reason = "rejected"): QueueItem {
    this.throwIfDead(null, 0n, typeof id === "string" ? id : null);
    this.tickOrBlock(this.items.get(id)?.planId ?? null, 0n, typeof id === "string" ? id : null);
    const it = this.live(id);
    const a = this.checkApprover(approver);
    if (it.status !== "pending") throw new Error(`cannot reject: status ${it.status}`);
    it.status = "rejected";
    it.decidedBy = a;
    it.reason = reason;
    this.emit("rejected", it.planId, it.amount, it.id, reason);
    return { ...it };
  }

  /** True only for an auto-approved or approved, not yet used, not expired plan. */
  canExecute(planId: string): boolean {
    if (this.deadBlock(planId, 0n, null)) return false;
    const id = this.byPlan.get(String(planId).toLowerCase());
    if (!this.clock()) { this.emit("blocked", planId, 0n, id ?? null, "BadNow"); return false; }
    if (!id) return false;
    const it = this.live(id);
    return it.status === "auto" || it.status === "approved";
  }

  /** One-time use. `amount` is mandatory: missing -> MissingAmount, different -> AmountMismatch. */
  consume(planId: string, amount: bigint): QueueItem {
    const p = String(planId).toLowerCase();
    const id = this.byPlan.get(p);
    const blockAmt = typeof amount === "bigint" ? amount : 0n;
    const block = (reason: QueueBlockReason, amt: bigint, itemId: string | null): never => {
      this.emit("blocked", p, amt, itemId, reason);
      throw new Error(`blocked: ${reason}`);
    };
    if (this.dead) return block("BadConfig", blockAmt, null);
    if (!this.clock()) return block("BadNow", blockAmt, id ?? null);
    if (!id) return block(this.seen.has(p) ? BLOCK_OF[this.seen.get(p)!] : "NotInQueue", blockAmt, null);
    const it = this.live(id);
    if (it.status !== "auto" && it.status !== "approved") return block(BLOCK_OF[it.status], typeof amount === "bigint" ? amount : it.amount, id);
    if (typeof amount !== "bigint") return block("MissingAmount", it.amount, id);
    if (amount !== it.amount) return block("AmountMismatch", blockAmt, id);
    it.status = "consumed";
    this.emit("consumed", it.planId, it.amount, id);
    return { ...it };
  }

  pending(): QueueItem[] {
    this.throwIfDead(null, 0n, null);
    this.tickOrBlock(null, 0n, null);
    return [...this.items.keys()].map((k) => this.live(k)).filter((it) => it.status === "pending").map((it) => ({ ...it }));
  }

  /** Items currently held in memory (for monitoring the pruning). */
  size(): number {
    return this.items.size;
  }
}
