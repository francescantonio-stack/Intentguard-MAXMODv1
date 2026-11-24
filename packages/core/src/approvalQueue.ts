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
export type QueueStatus = "auto" | "pending" | "approved" | "rejected" | "expired" | "consumed";

/** Block reasons, aligned with ActionBlocked(planId, reason, amount). */
export type BlockReason = "NotInQueue" | "Pending" | "Consumed" | "Expired" | "Rejected" | "AmountMismatch";

export type QueueEvent = {
  kind: "queued" | "auto_approved" | "approved" | "rejected" | "expired" | "consumed" | "blocked";
  planId: `0x${string}`;
  reason: string; // BlockReason for "blocked"; queue reason or "" otherwise
  amount: bigint; // base units
  ts: string;
  id: string | null;
};

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
  /** Window for summing auto-approvals (anti-splitting) and for keeping closed items. Default 24 h. */
  windowMs?: number;
  /** How long an item (pending, auto or approved) stays valid. Default 1 h (policy plan TTL cap). */
  ttlMs?: number;
  /** If set, only these approvers count. */
  approvers?: string[];
  now?: () => number;
  onEvent?: (e: QueueEvent) => void;
}

const PLAN_RE = /^0x[0-9a-f]{64}$/;
const CLOSED: ReadonlySet<QueueStatus> = new Set(["expired", "rejected", "consumed"]);
const BLOCK_OF: Record<QueueStatus, BlockReason> = {
  pending: "Pending", consumed: "Consumed", expired: "Expired", rejected: "Rejected",
  auto: "NotInQueue", approved: "NotInQueue", // never used for blocks of runnable items
};

export class ApprovalQueue {
  private items = new Map<string, QueueItem>();
  private byPlan = new Map<string, string>();
  /** planIds of pruned items -> final status. Kept forever to block replay. */
  private seen = new Map<string, QueueStatus>();
  private seq = 0;
  private readonly thresholds: Map<string, bigint>;
  private readonly approvers?: Set<string>;
  private readonly windowMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onEvent?: (e: QueueEvent) => void;

  constructor(cfg: ApprovalQueueConfig) {
    this.windowMs = cfg.windowMs ?? 86_400_000;
    this.ttlMs = cfg.ttlMs ?? 3_600_000;
    if (!(Number.isFinite(this.windowMs) && this.windowMs > 0)) throw new Error("windowMs must be > 0");
    if (!(Number.isFinite(this.ttlMs) && this.ttlMs > 0)) throw new Error("ttlMs must be > 0");
    this.thresholds = new Map();
    for (const [k, v] of Object.entries(cfg.thresholds)) {
      if (typeof v !== "bigint" || v < 0n) throw new Error(`threshold for ${k} must be a non-negative bigint`);
      this.thresholds.set(k.toUpperCase(), v);
    }
    this.approvers = cfg.approvers ? new Set(cfg.approvers.map((a) => a.toLowerCase())) : undefined;
    this.now = cfg.now ?? (() => Date.now());
    this.onEvent = cfg.onEvent;
  }

  private emit(kind: QueueEvent["kind"], planId: string, amount: bigint, id: string | null, reason = "") {
    this.onEvent?.({ kind, planId: planId as `0x${string}`, reason, amount, ts: new Date(this.now()).toISOString(), id });
  }

  private checkApprover(approver: string): string {
    const a = String(approver ?? "").toLowerCase();
    if (!a || (this.approvers && !this.approvers.has(a))) throw new Error("approver not allowed");
    return a;
  }

  /** Drop closed items older than the window; remember their planId to block replay. */
  private prune(): void {
    const from = this.now() - this.windowMs;
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
    const t = String(token).toUpperCase();
    const from = this.now() - this.windowMs;
    let s = 0n;
    for (const id of this.items.keys()) {
      const it = this.live(id);
      if (it.token === t && it.autoApproved && it.createdAt >= from && (it.status === "auto" || it.status === "consumed")) s += it.amount;
    }
    return s;
  }

  submit(req: PaymentRequest): QueueItem {
    if (typeof req.amount !== "bigint" || req.amount <= 0n) throw new Error("amount must be a positive bigint");
    const planId = String(req.planId ?? "").toLowerCase();
    if (!PLAN_RE.test(planId)) throw new Error("planId must be 32 bytes hex");
    const token = String(req.token ?? "").toUpperCase();
    if (!token) throw new Error("token required");
    this.prune();
    if (this.byPlan.has(planId) || this.seen.has(planId)) throw new Error("plan already submitted");
    const threshold = this.thresholds.get(token);
    const now = this.now();
    const id = `q${++this.seq}`;
    // Unknown token: no threshold configured -> always a human (fail-closed).
    const auto = threshold !== undefined && this.autoSpent(token) + req.amount <= threshold;
    const it: QueueItem = {
      ...req, planId: planId as `0x${string}`, token, id,
      status: auto ? "auto" : "pending", autoApproved: auto, createdAt: now, expiresAt: now + this.ttlMs,
    };
    if (!auto) it.reason = threshold === undefined ? "NoThreshold" : req.amount > threshold ? "AboveThreshold" : "WindowTotal";
    this.items.set(id, it);
    this.byPlan.set(planId, id);
    this.emit(auto ? "auto_approved" : "queued", planId, it.amount, id, it.reason);
    return { ...it };
  }

  /** Expires pending, auto and approved items past their TTL. */
  private live(id: string): QueueItem {
    const it = this.items.get(id);
    if (!it) throw new Error(`unknown item ${id}`);
    if ((it.status === "pending" || it.status === "auto" || it.status === "approved") && this.now() > it.expiresAt) {
      it.status = "expired";
      this.emit("expired", it.planId, it.amount, it.id);
    }
    return it;
  }

  /** Approval is bound to the exact plan: `planId` must match what was queued. */
  approve(id: string, approver: string, planId: string): QueueItem {
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
    const id = this.byPlan.get(String(planId).toLowerCase());
    if (!id) return false;
    const it = this.live(id);
    return it.status === "auto" || it.status === "approved";
  }

  /** One-time use. Throws (and logs a block) if the plan may not run or the amount differs. */
  consume(planId: string, amount?: bigint): QueueItem {
    const p = String(planId).toLowerCase();
    const id = this.byPlan.get(p);
    const blockAmt = typeof amount === "bigint" ? amount : 0n;
    const block = (reason: BlockReason, amt: bigint, itemId: string | null): never => {
      this.emit("blocked", p, amt, itemId, reason);
      throw new Error(`blocked: ${reason}`);
    };
    if (!id) return block(this.seen.has(p) ? BLOCK_OF[this.seen.get(p)!] : "NotInQueue", blockAmt, null);
    const it = this.live(id);
    if (it.status !== "auto" && it.status !== "approved") return block(BLOCK_OF[it.status], amount ?? it.amount, id);
    if (amount !== undefined && amount !== it.amount) return block("AmountMismatch", blockAmt, id);
    it.status = "consumed";
    this.emit("consumed", it.planId, it.amount, id);
    return { ...it };
  }

  pending(): QueueItem[] {
    return [...this.items.keys()].map((k) => this.live(k)).filter((it) => it.status === "pending").map((it) => ({ ...it }));
  }

  /** Items currently held in memory (for monitoring the pruning). */
  size(): number {
    return this.items.size;
  }
}
