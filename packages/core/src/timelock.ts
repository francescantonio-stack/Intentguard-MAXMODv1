/**
 * Time-lock and emergency kill switch (Sentinel idea).
 * Pure TS, no network, no keys, no signing. Enforcement is off-chain: the executor must
 * call `consume` before running a plan. Fail-closed on any bad input.
 *
 * Actions above a per-token threshold, or of a sensitive type (policy/limit change,
 * unlimited approve, adding a signer), are queued until `earliest` and can be cancelled
 * in the meantime. `pause` stops every execution, including items already queued.
 * Unpause is itself time-locked and may be requested only by the owner or a guardian.
 */
import type { QueueEvent } from "./events";


type GuardEvent = QueueEvent;

export const lowerPlanId = (id: string): `0x${string}` => {
  const s = id.trim();
  return (s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`).toLowerCase() as `0x${string}`;
};

export const upperToken = (t: string) => t.toUpperCase();

export function guardEvent(o: { kind: QueueEvent["kind"]; planId: string; reason: string; amount: bigint; now: number; id?: string | null }): QueueEvent {
  const ts = Number.isFinite(o.now) ? new Date(o.now).toISOString() : new Date().toISOString();
  const amount = typeof o.amount === "bigint" ? o.amount : 0n;
  return { kind: o.kind, planId: lowerPlanId(o.planId), reason: o.reason, amount, ts, id: o.id ?? null };
}

export function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
    return Number(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

export function asAmount(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return BigInt(v);
  return undefined;
}

const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;
const PLAN_ID_RE = /^0x[0-9a-f]{64}$/;
export const DEFAULT_SENSITIVE = ["policy_change", "limit_change", "unlimited_approve", "add_signer"] as const;
export const WINDOW_MS = 86_400_000;

export type ActionKind = "transfer" | "policy_change" | "limit_change" | "unlimited_approve" | "add_signer" | (string & {});

export type TimelockRequest = {
  planId: string;
  amount: bigint | number;
  token: string;
  kind: ActionKind;
  requester?: string;
  /** Optional delay. May only tighten the configured delay, never widen it. */
  delayMs?: number;
};

type Status = "queued" | "consumed" | "cancelled" | "expired" | "rejected";
type Row = {
  planId: `0x${string}`;
  amount: bigint;
  token: string;
  kind: string;
  requester: string;
  status: Status;
  queuedAt: number;
  earliest: number;
  expiresAt: number;
  decidedAt?: number;
};
type History = { status: Status; amount: bigint };

export type SentinelConfig = {
  delayMs: number;
  /** Per-token threshold in base units: amounts strictly above are time-locked. Missing token => always locked. */
  thresholds?: Record<string, bigint>;
  sensitive?: readonly string[];
  owner: string;
  guardians?: string[];
  unpauseDelayMs?: number;
  /** How long a queued item stays executable after `earliest`. Default 24h. */
  ttlMs?: number;
  windowMs?: number;
  now?: () => number;
  onEvent?: (e: QueueEvent) => void;
};

export class SentinelError extends Error {
  constructor(public readonly code: string, message: string, public readonly event: QueueEvent) {
    super(message);
    this.name = "SentinelError";
  }
}

function positiveFinite(v: unknown): number | undefined {
  const n = asFiniteNumber(v);
  if (n === undefined || n <= 0) return undefined;
  return n;
}

export class Sentinel {
  private rows = new Map<string, Row>();
  private seen = new Set<string>();
  /** Per-planId final record. Survives prune and remove. */
  private history = new Map<string, History>();
  private paused = false;
  private unpauseAt: number | null = null;
  private unpauseBy: string | null = null;
  private lastNow: number | undefined;
  private readonly owner!: string;
  private readonly guardians!: Set<string>;
  private readonly delayMs!: number;
  private readonly unpauseDelayMs!: number;
  private readonly ttlMs!: number;
  private readonly windowMs!: number;
  private readonly thresholds!: Record<string, bigint>;
  private readonly sensitive!: Set<string>;
  private readonly nowFn!: () => number;
  private readonly onEvent?: (e: QueueEvent) => void;

  constructor(cfg: SentinelConfig) {
    const emitCfg = (reason: string): never => {
      const ev = guardEvent({ kind: "blocked", planId: ZERO_HASH, reason, amount: 0n, now: Date.now(), id: null });
      cfg && typeof cfg === "object" && cfg.onEvent?.(ev);
      throw new SentinelError("BAD_CONFIG", reason, ev);
    };
    if (!cfg || typeof cfg !== "object") {
      const ev = guardEvent({ kind: "blocked", planId: ZERO_HASH, reason: "BAD_CONFIG", amount: 0n, now: Date.now(), id: null });
      throw new SentinelError("BAD_CONFIG", "BAD_CONFIG", ev);
    }
    const delayMs = positiveFinite(cfg.delayMs);
    if (delayMs === undefined) return emitCfg("BAD_CONFIG: delayMs");
    if (typeof cfg.owner !== "string" || !cfg.owner) emitCfg("BAD_CONFIG: owner");
    if ("unpauseDelayMs" in cfg && cfg.unpauseDelayMs !== undefined && positiveFinite(cfg.unpauseDelayMs) === undefined) {
      emitCfg("BAD_CONFIG: unpauseDelayMs");
    }
    if ("ttlMs" in cfg && cfg.ttlMs !== undefined && positiveFinite(cfg.ttlMs) === undefined) {
      emitCfg("BAD_CONFIG: ttlMs");
    }
    if ("windowMs" in cfg && cfg.windowMs !== undefined && positiveFinite(cfg.windowMs) === undefined) {
      emitCfg("BAD_CONFIG: windowMs");
    }
    if (cfg.guardians !== undefined && !Array.isArray(cfg.guardians)) emitCfg("BAD_CONFIG: guardians");
    if (cfg.thresholds !== undefined) {
      if (!cfg.thresholds || typeof cfg.thresholds !== "object" || Array.isArray(cfg.thresholds)) emitCfg("BAD_CONFIG: thresholds");
      for (const v of Object.values(cfg.thresholds)) {
        if (typeof v !== "bigint" || v < 0n) emitCfg("BAD_CONFIG: thresholds");
      }
    }
    this.delayMs = delayMs;
    this.unpauseDelayMs = cfg.unpauseDelayMs !== undefined ? positiveFinite(cfg.unpauseDelayMs)! : delayMs;
    this.ttlMs = cfg.ttlMs !== undefined ? positiveFinite(cfg.ttlMs)! : WINDOW_MS;
    this.windowMs = cfg.windowMs !== undefined ? positiveFinite(cfg.windowMs)! : WINDOW_MS;
    this.owner = cfg.owner.toLowerCase();
    this.guardians = new Set((cfg.guardians ?? []).map((g) => g.toLowerCase()));
    this.thresholds = {};
    for (const [k, v] of Object.entries(cfg.thresholds ?? {})) this.thresholds[upperToken(k)] = v;
    this.sensitive = new Set((cfg.sensitive ?? DEFAULT_SENSITIVE).map((s) => s.toLowerCase()));
    this.nowFn = cfg.now ?? (() => Date.now());
    this.onEvent = cfg.onEvent;
  }

  isPaused = () => this.paused;
  isGuardian = (who: string) => {
    const w = who.toLowerCase();
    return w === this.owner || this.guardians.has(w);
  };
  historyOf = (planId: string) => this.history.get(lowerPlanId(planId));

  /**
   * Drops the live row only. History and seen planIds stay, so a recreate with the
   * same id cannot reset replay or limits.
   */
  remove(planIdRaw: string): void {
    const now = this.now();
    const planId = typeof planIdRaw === "string" ? lowerPlanId(planIdRaw) : ZERO_HASH;
    this.rows.delete(planId);
    void now;
  }

  /** Whether this action must wait. Fail-closed: unknown token or bad amount => locked. */
  needsLock(kind: string, token: string, amount: bigint): boolean {
    if (this.sensitive.has(kind.toLowerCase())) return true;
    const cap = this.thresholds[upperToken(token)];
    if (cap === undefined) return true;
    return amount > cap;
  }

  private now(): number {
    const n = asFiniteNumber(this.nowFn());
    if (n === undefined || (this.lastNow !== undefined && n < this.lastNow)) {
      const e = this.emit("blocked", ZERO_HASH, "BAD_NOW", 0n, Date.now(), null);
      throw new SentinelError("BAD_NOW", "BAD_NOW", e);
    }
    this.lastNow = n;
    return n;
  }

  private emit(kind: QueueEvent["kind"], planId: string, reason: string, amount: bigint, now: number, id: string | null = null): QueueEvent {
    const ev = guardEvent({ kind, planId, reason, amount, now, id });
    this.onEvent?.(ev);
    return ev;
  }

  private remember(row: Row) {
    this.rows.set(row.planId, row);
    this.seen.add(row.planId);
    this.history.set(row.planId, { status: row.status, amount: row.amount });
  }

  private prune(now: number) {
    const cut = now - this.windowMs;
    for (const [k, r] of this.rows) {
      if ((r.status === "expired" || r.status === "cancelled" || r.status === "consumed" || r.status === "rejected") && (r.decidedAt ?? r.expiresAt) < cut) {
        this.rows.delete(k);
      }
    }
  }

  private live(r: Row, now: number): Row {
    if ((r.status === "queued") && now > r.expiresAt) {
      const next = { ...r, status: "expired" as const, decidedAt: now };
      this.remember(next);
      this.emit("expired", r.planId, "Expired", r.amount, now, r.planId);
      return next;
    }
    return r;
  }

  queue(req: TimelockRequest): { ok: true; queued: boolean; earliest: number; event: QueueEvent } {
    const now = this.now();
    this.prune(now);
    if (!req || typeof req !== "object") {
      const ev = this.emit("blocked", ZERO_HASH, "MALFORMED", 0n, now, null);
      throw new SentinelError("MALFORMED", "MALFORMED", ev);
    }
    if (typeof req.planId !== "string" || !PLAN_ID_RE.test(req.planId.toLowerCase())) {
      const ev = this.emit("blocked", typeof req.planId === "string" ? lowerPlanId(req.planId) : ZERO_HASH, "MALFORMED", asAmount(req.amount) ?? 0n, now, null);
      throw new SentinelError("MALFORMED", "MALFORMED", ev);
    }
    const planId = lowerPlanId(req.planId);
    const amount = asAmount(req.amount);
    if (amount === undefined || amount < 0n) {
      const ev = this.emit("blocked", planId, "MALFORMED", 0n, now, planId);
      throw new SentinelError("MALFORMED", "MALFORMED", ev);
    }
    if (typeof req.token !== "string" || !req.token || typeof req.kind !== "string" || !req.kind) {
      const ev = this.emit("blocked", planId, "MALFORMED", amount, now, planId);
      throw new SentinelError("MALFORMED", "MALFORMED", ev);
    }
    if (this.seen.has(planId) || this.history.has(planId)) {
      const h = this.history.get(planId);
      const reason = h?.status === "consumed" ? "Consumed" : h?.status === "cancelled" ? "Cancelled" : h?.status === "expired" ? "Expired" : "Replay";
      const ev = this.emit("blocked", planId, reason, amount, now, planId);
      throw new SentinelError(reason, reason, ev);
    }
    let delay = this.delayMs;
    if ("delayMs" in req && req.delayMs !== undefined) {
      const d = positiveFinite(req.delayMs);
      if (d === undefined) {
        const ev = this.emit("blocked", planId, "BAD_CONFIG: delayMs", amount, now, planId);
        throw new SentinelError("BAD_CONFIG", "BAD_CONFIG: delayMs", ev);
      }
      delay = Math.min(d, this.delayMs);
    }
    const token = upperToken(req.token);
    const kind = req.kind.toLowerCase();
    const lock = this.needsLock(kind, token, amount);
    const earliest = lock ? now + delay : now;
    const row: Row = {
      planId, amount, token, kind,
      requester: (req.requester ?? "").toLowerCase(),
      status: "queued",
      queuedAt: now,
      earliest,
      expiresAt: earliest + this.ttlMs,
    };
    this.remember(row);
    const event = this.emit("queued", planId, lock ? "timelock_pending" : "Ready", amount, now, planId);
    return { ok: true, queued: lock, earliest, event };
  }

  cancel(planIdRaw: string, by: string): QueueEvent {
    const now = this.now();
    this.prune(now);
    const planId = typeof planIdRaw === "string" ? lowerPlanId(planIdRaw) : ZERO_HASH;
    const row = this.rows.get(planId);
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!row) {
      const h = this.history.get(planId);
      const ev = this.emit("blocked", planId, h ? (h.status === "consumed" ? "Consumed" : h.status === "cancelled" ? "Cancelled" : "NotCancellable") : "NotInQueue", h?.amount ?? 0n, now, planId);
      throw new SentinelError(ev.reason, ev.reason, ev);
    }
    const live = this.live(row, now);
    if (live.status !== "queued") {
      const ev = this.emit("blocked", planId, live.status === "expired" ? "Expired" : "NotCancellable", live.amount, now, planId);
      throw new SentinelError(ev.reason, ev.reason, ev);
    }
    if (who !== live.requester && !this.isGuardian(who)) {
      const ev = this.emit("blocked", planId, "Unauthorized", live.amount, now, planId);
      throw new SentinelError("Unauthorized", "Unauthorized", ev);
    }
    this.remember({ ...live, status: "cancelled", decidedAt: now });
    return this.emit("rejected", planId, "Cancelled", live.amount, now, planId);
  }

  /**
   * Execute a queued plan. `amount` is required and must match the queued amount.
   * Too early -> blocked `timelock_pending`. Paused -> `paused`.
   * After the delay, works once. After TTL, throws `Expired`.
   */
  consume(planIdRaw: string, o: { amount?: bigint; by?: string } = {}): QueueEvent {
    const now = this.now();
    this.prune(now);
    const planId = typeof planIdRaw === "string" ? lowerPlanId(planIdRaw) : ZERO_HASH;
    const amountProvided = o !== undefined && o !== null && typeof o === "object" && "amount" in o && o.amount !== undefined;
    const known = amountProvided ? asAmount(o.amount) : undefined;
    const row0 = this.rows.get(planId);
    const hist = this.history.get(planId);
    const fallbackAmt = row0?.amount ?? hist?.amount ?? 0n;
    if (this.paused) {
      const ev = this.emit("blocked", planId, "paused", known ?? fallbackAmt, now, planId);
      throw new SentinelError("paused", "paused", ev);
    }
    if (!amountProvided) {
      const ev = this.emit("blocked", planId, "MissingAmount", fallbackAmt, now, planId);
      throw new SentinelError("MissingAmount", "MissingAmount", ev);
    }
    if (known === undefined) {
      const ev = this.emit("blocked", planId, "dati incompleti: amount", fallbackAmt, now, planId);
      throw new SentinelError("dati incompleti: amount", "dati incompleti: amount", ev);
    }
    const amt = known;
    if (!row0) {
      const reason = hist ? (hist.status === "consumed" ? "Consumed" : hist.status === "cancelled" ? "Cancelled" : hist.status === "expired" ? "Expired" : "Replay") : (this.seen.has(planId) ? "Replay" : "NotInQueue");
      const ev = this.emit("blocked", planId, reason, amt, now, planId);
      throw new SentinelError(reason, reason, ev);
    }
    const row = this.live(row0, now);
    if (row.status === "consumed") {
      const ev = this.emit("blocked", planId, "Consumed", amt, now, planId);
      throw new SentinelError("Consumed", "Consumed", ev);
    }
    if (row.status === "cancelled") {
      const ev = this.emit("blocked", planId, "Cancelled", amt, now, planId);
      throw new SentinelError("Cancelled", "Cancelled", ev);
    }
    if (row.status === "expired" || now > row.expiresAt) {
      this.remember({ ...row, status: "expired", decidedAt: now });
      const ev = this.emit("expired", planId, "Expired", amt, now, planId);
      throw new SentinelError("Expired", "Expired", ev);
    }
    if (now < row.earliest) {
      const ev = this.emit("blocked", planId, "timelock_pending", amt, now, planId);
      throw new SentinelError("timelock_pending", "timelock_pending", ev);
    }
    if (amt !== row.amount) {
      const ev = this.emit("blocked", planId, "AmountMismatch", amt, now, planId);
      throw new SentinelError("AmountMismatch", "AmountMismatch", ev);
    }
    this.remember({ ...row, status: "consumed", decidedAt: now, amount: amt });
    return this.emit("consumed", planId, "Consumed", amt, now, planId);
  }

  pause(by: string): QueueEvent {
    const now = this.now();
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!this.isGuardian(who)) {
      const ev = this.emit("blocked", ZERO_HASH, "Unauthorized", 0n, now, null);
      throw new SentinelError("Unauthorized", "Unauthorized", ev);
    }
    this.paused = true;
    this.unpauseAt = null;
    this.unpauseBy = null;
    return this.emit("blocked", ZERO_HASH, "paused", 0n, now, null);
  }

  /** Owner/guardian requests unpause; it becomes effective only after `unpauseDelayMs`. */
  requestUnpause(by: string): QueueEvent {
    const now = this.now();
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!this.isGuardian(who)) {
      const ev = this.emit("blocked", ZERO_HASH, "Unauthorized", 0n, now, null);
      throw new SentinelError("Unauthorized", "Unauthorized", ev);
    }
    if (!this.paused) {
      const ev = this.emit("blocked", ZERO_HASH, "NotPaused", 0n, now, null);
      throw new SentinelError("NotPaused", "NotPaused", ev);
    }
    this.unpauseAt = now + this.unpauseDelayMs;
    this.unpauseBy = who;
    return this.emit("queued", ZERO_HASH, "unpause_pending", 0n, now, null);
  }

  finalizeUnpause(by: string): QueueEvent {
    const now = this.now();
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!this.isGuardian(who)) {
      const ev = this.emit("blocked", ZERO_HASH, "Unauthorized", 0n, now, null);
      throw new SentinelError("Unauthorized", "Unauthorized", ev);
    }
    if (!this.paused) {
      const ev = this.emit("blocked", ZERO_HASH, "NotPaused", 0n, now, null);
      throw new SentinelError("NotPaused", "NotPaused", ev);
    }
    if (this.unpauseAt === null) {
      const ev = this.emit("blocked", ZERO_HASH, "unpause_pending", 0n, now, null);
      throw new SentinelError("unpause_pending", "unpause_pending", ev);
    }
    if (now < this.unpauseAt) {
      const ev = this.emit("blocked", ZERO_HASH, "unpause_pending", 0n, now, null);
      throw new SentinelError("unpause_pending", "unpause_pending", ev);
    }
    this.paused = false;
    this.unpauseAt = null;
    this.unpauseBy = null;
    return this.emit("approved", ZERO_HASH, "Unpaused", 0n, now, null);
  }
}
