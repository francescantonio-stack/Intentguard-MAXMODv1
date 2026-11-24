/**
 * Approval queue (Rienda idea): payments above a threshold wait for an explicit human approval.
 * Pure and in-memory: no network, no keys, no signing. The executor must call `canExecute`/`consume`
 * before running a plan; anything not auto-approved or approved stays blocked (fail-closed).
 *
 * Anti-splitting: auto-approvals are summed over a rolling window, so ten payments of 0.9 cannot
 * slip under a threshold of 1.
 */
export type QueueStatus = "auto" | "pending" | "approved" | "rejected" | "expired" | "consumed";

export interface PaymentRequest {
  planHash: `0x${string}`;
  token: string;
  amount: bigint; // base units
  to: string;
  summary?: string;
}

export interface QueueItem extends PaymentRequest {
  id: string;
  status: QueueStatus;
  createdAt: number; // ms
  expiresAt: number; // ms
  decidedBy?: string;
  reason?: string;
}

export interface QueueEvent {
  ts: string;
  kind: "queued" | "auto_approved" | "approved" | "rejected" | "expired" | "consumed" | "blocked";
  id: string | null;
  planHash: string;
  amount: string;
  reason?: string;
}

export interface ApprovalQueueConfig {
  /** Per token: amounts strictly above this need a human. */
  thresholds: Record<string, bigint>;
  /** Window for summing auto-approvals (anti-splitting). Default 24 h. */
  windowMs?: number;
  /** How long a pending item stays approvable. Default 1 h (same as the policy plan TTL cap). */
  ttlMs?: number;
  /** If set, only these approvers count. */
  approvers?: string[];
  now?: () => number;
  onEvent?: (e: QueueEvent) => void;
}

export class ApprovalQueue {
  private items = new Map<string, QueueItem>();
  private byPlan = new Map<string, string>();
  private seq = 0;
  private readonly cfg: Required<Omit<ApprovalQueueConfig, "approvers" | "onEvent">> &
    Pick<ApprovalQueueConfig, "approvers" | "onEvent">;

  constructor(cfg: ApprovalQueueConfig) {
    this.cfg = { windowMs: 86_400_000, ttlMs: 3_600_000, now: () => Date.now(), ...cfg };
  }

  private emit(kind: QueueEvent["kind"], it: Pick<QueueItem, "planHash" | "amount"> & { id?: string }, reason?: string) {
    this.cfg.onEvent?.({
      ts: new Date(this.cfg.now()).toISOString(),
      kind,
      id: it.id ?? null,
      planHash: it.planHash,
      amount: it.amount.toString(),
      ...(reason ? { reason } : {}),
    });
  }

  /** Sum of auto-approved amounts for `token` inside the window. */
  autoSpent(token: string): bigint {
    const from = this.cfg.now() - this.cfg.windowMs;
    let s = 0n;
    for (const it of this.items.values()) {
      if (it.token === token && it.createdAt >= from && (it.status === "auto" || (it.status === "consumed" && !it.decidedBy))) s += it.amount;
    }
    return s;
  }

  submit(req: PaymentRequest): QueueItem {
    if (typeof req.amount !== "bigint" || req.amount <= 0n) throw new Error("amount must be a positive bigint");
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.planHash)) throw new Error("planHash must be 32 bytes hex");
    if (this.byPlan.has(req.planHash)) throw new Error("plan already submitted");
    const threshold = this.cfg.thresholds[req.token];
    const now = this.cfg.now();
    const id = `q${++this.seq}`;
    // Unknown token: no threshold configured -> always a human (fail-closed).
    const auto = threshold !== undefined && this.autoSpent(req.token) + req.amount <= threshold;
    const it: QueueItem = { ...req, id, status: auto ? "auto" : "pending", createdAt: now, expiresAt: now + this.cfg.ttlMs };
    if (!auto) it.reason = threshold === undefined ? "no threshold for token" : req.amount > threshold ? "above threshold" : "window total above threshold";
    this.items.set(id, it);
    this.byPlan.set(req.planHash, id);
    this.emit(auto ? "auto_approved" : "queued", it, it.reason);
    return { ...it };
  }

  private live(id: string): QueueItem {
    const it = this.items.get(id);
    if (!it) throw new Error(`unknown item ${id}`);
    if (it.status === "pending" && this.cfg.now() > it.expiresAt) {
      it.status = "expired";
      this.emit("expired", it);
    }
    return it;
  }

  /** Approval is bound to the exact plan: `planHash` must match what was queued. */
  approve(id: string, approver: string, planHash: string): QueueItem {
    const it = this.live(id);
    if (this.cfg.approvers && !this.cfg.approvers.includes(approver)) throw new Error("approver not allowed");
    if (it.planHash !== planHash) throw new Error("planHash mismatch: approval is for a different plan");
    if (it.status !== "pending") throw new Error(`cannot approve: status ${it.status}`);
    it.status = "approved";
    it.decidedBy = approver;
    this.emit("approved", it);
    return { ...it };
  }

  reject(id: string, approver: string, reason = "rejected"): QueueItem {
    const it = this.live(id);
    if (this.cfg.approvers && !this.cfg.approvers.includes(approver)) throw new Error("approver not allowed");
    if (it.status !== "pending") throw new Error(`cannot reject: status ${it.status}`);
    it.status = "rejected";
    it.decidedBy = approver;
    it.reason = reason;
    this.emit("rejected", it, reason);
    return { ...it };
  }

  /** True only for an auto-approved or approved, not yet used, not expired plan. */
  canExecute(planHash: string): boolean {
    const id = this.byPlan.get(planHash);
    if (!id) return false;
    const it = this.live(id);
    return it.status === "auto" || it.status === "approved";
  }

  /** One-time use. Throws (and logs a block) if the plan may not run. */
  consume(planHash: string): QueueItem {
    const id = this.byPlan.get(planHash);
    if (!id || !this.canExecute(planHash)) {
      const it = id ? this.items.get(id)! : { planHash: planHash as `0x${string}`, amount: 0n };
      const reason = id ? `status ${this.items.get(id)!.status}` : "not in queue";
      this.emit("blocked", it, reason);
      throw new Error(`blocked: ${reason}`);
    }
    const it = this.items.get(id)!;
    it.status = "consumed";
    this.emit("consumed", it);
    return { ...it };
  }

  pending(): QueueItem[] {
    return [...this.items.keys()].map((k) => this.live(k)).filter((it) => it.status === "pending").map((it) => ({ ...it }));
  }
}
