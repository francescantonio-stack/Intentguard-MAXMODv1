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
import { asAmount, asFiniteNumber, guardEvent, lowerPlanId, upperToken, ZERO_PLAN } from "./guards";


type GuardEvent = QueueEvent;

const ZERO_HASH = ZERO_PLAN;
const safePlanId = (id: unknown): `0x${string}` => lowerPlanId(id) ?? ZERO_PLAN;

/** Hard maxima for operator-supplied durations. null/missing → module default. Above the max → BAD_CONFIG (never clamped). */
const TIMELOCK_DELAY_MAX_MS = 30 * 86_400_000; // 30 days (delayMs, unpauseDelayMs, ttlMs)
const TIMELOCK_WINDOW_MAX_MS = 7 * 86_400_000; // 7 days (windowMs)

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

function positiveFinite(v: unknown, max?: number): number | null {
  const n = asFiniteNumber(v);
  if (n == null || n <= 0) return null;
  if (max !== undefined && n > max) return null;
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
  private owner!: string;
  private guardians!: Set<string>;
  private delayMs!: number;
  private unpauseDelayMs!: number;
  private ttlMs!: number;
  private windowMs!: number;
  private thresholds!: Record<string, bigint>;
  private sensitive!: Set<string>;
  private nowFn!: () => number;
  private onEvent?: (e: QueueEvent) => void;

  /** Set when construction config is invalid. Methods emit this and write nothing. */
  readonly configError: QueueEvent | null = null;

  constructor(cfg: SentinelConfig) {
    const emitCfg = (reason: string): QueueEvent => {
      const ev = guardEvent({ kind: "blocked", planId: ZERO_HASH, reason, amount: 0n, now: Date.now(), id: null });
      cfg && typeof cfg === "object" && cfg.onEvent?.(ev);
      return ev;
    };
    const fault = (reason: string) => {
      (this as { configError: QueueEvent | null }).configError = emitCfg(reason);
      this.delayMs = 1;
      this.unpauseDelayMs = 1;
      this.ttlMs = WINDOW_MS;
      this.windowMs = WINDOW_MS;
      this.owner = "";
      this.guardians = new Set();
      this.thresholds = {};
      this.sensitive = new Set();
      this.nowFn = () => Date.now();
      this.onEvent = cfg && typeof cfg === "object" ? cfg.onEvent : undefined;
    };
    if (!cfg || typeof cfg !== "object") { fault("BAD_CONFIG"); return; }
    const delayMs = positiveFinite(cfg.delayMs, TIMELOCK_DELAY_MAX_MS);
    if (delayMs == null) { fault("BAD_CONFIG: delayMs"); return; }
    if (typeof cfg.owner !== "string" || !cfg.owner) { fault("BAD_CONFIG: owner"); return; }
    if ("unpauseDelayMs" in cfg && cfg.unpauseDelayMs !== undefined && cfg.unpauseDelayMs !== null
        && positiveFinite(cfg.unpauseDelayMs, TIMELOCK_DELAY_MAX_MS) == null) {
      fault("BAD_CONFIG: unpauseDelayMs"); return;
    }
    if ("ttlMs" in cfg && cfg.ttlMs !== undefined && cfg.ttlMs !== null
        && positiveFinite(cfg.ttlMs, TIMELOCK_DELAY_MAX_MS) == null) {
      fault("BAD_CONFIG: ttlMs"); return;
    }
    if ("windowMs" in cfg && cfg.windowMs !== undefined && cfg.windowMs !== null
        && positiveFinite(cfg.windowMs, TIMELOCK_WINDOW_MAX_MS) == null) {
      fault("BAD_CONFIG: windowMs"); return;
    }
    if (cfg.guardians !== undefined && !Array.isArray(cfg.guardians)) { fault("BAD_CONFIG: guardians"); return; }
    if (cfg.sensitive !== undefined && !Array.isArray(cfg.sensitive)) { fault("BAD_CONFIG: sensitive"); return; }
    if (cfg.thresholds !== undefined) {
      if (!cfg.thresholds || typeof cfg.thresholds !== "object" || Array.isArray(cfg.thresholds)) { fault("BAD_CONFIG: thresholds"); return; }
      for (const v of Object.values(cfg.thresholds)) {
        if (typeof v !== "bigint" || v < 0n) { fault("BAD_CONFIG: thresholds"); return; }
      }
    }
    this.delayMs = delayMs;
    this.unpauseDelayMs = cfg.unpauseDelayMs !== undefined && cfg.unpauseDelayMs !== null
      ? positiveFinite(cfg.unpauseDelayMs, TIMELOCK_DELAY_MAX_MS)! : delayMs;
    this.ttlMs = cfg.ttlMs !== undefined && cfg.ttlMs !== null
      ? positiveFinite(cfg.ttlMs, TIMELOCK_DELAY_MAX_MS)! : WINDOW_MS;
    this.windowMs = cfg.windowMs !== undefined && cfg.windowMs !== null
      ? positiveFinite(cfg.windowMs, TIMELOCK_WINDOW_MAX_MS)! : WINDOW_MS;
    this.owner = cfg.owner.toLowerCase();
    this.guardians = new Set((cfg.guardians ?? []).map((g) => g.toLowerCase()));
    this.thresholds = {};
    for (const [k, v] of Object.entries(cfg.thresholds ?? {})) {
      const tok = upperToken(k);
      if (tok) this.thresholds[tok] = v;
    }
    this.sensitive = new Set((cfg.sensitive ?? DEFAULT_SENSITIVE).map((s) => s.toLowerCase()));
    this.nowFn = cfg.now ?? (() => Date.now());
    this.onEvent = cfg.onEvent;
  }

  isPaused = () => this.paused;
  isGuardian = (who: string) => {
    const w = who.toLowerCase();
    return w === this.owner || this.guardians.has(w);
  };
  historyOf = (planId: string) => this.history.get(safePlanId(planId));

  /**
   * Drops the live row only. History and seen planIds stay, so a recreate with the
   * same id cannot reset replay or limits.
   */
  remove(planIdRaw: string): void {
    const clock = this.readNow();
    if (!clock.ok) return;
    const planId = lowerPlanId(planIdRaw);
    if (planId) this.rows.delete(planId);
  }

  lookup(planIdRaw: unknown): { ok: true; history: History } | { ok: false; event: QueueEvent } {
    const clock = this.readNow();
    if (!clock.ok) return { ok: false, event: clock.event };
    const now = clock.now;
    const planId = lowerPlanId(planIdRaw);
    if (!planId) {
      return { ok: false, event: this.emit("blocked", ZERO_HASH, "MALFORMED", 0n, now, null) };
    }
    const history = this.history.get(planId);
    if (!history) {
      return { ok: false, event: this.emit("blocked", planId, "Unknown", 0n, now, planId) };
    }
    return { ok: true, history };
  }

  /** Whether this action must wait. Fail-closed: unknown token or bad amount => locked. */
  needsLock(kind: string, token: string, amount: bigint): boolean {
    if (this.sensitive.has(kind.toLowerCase())) return true;
    const cap = this.thresholds[upperToken(token) ?? ""];
    if (cap === undefined) return true;
    return amount > cap;
  }

  private readNow(): { ok: true; now: number } | { ok: false; event: QueueEvent } {
    if (this.configError) return { ok: false, event: this.emit("blocked", ZERO_HASH, this.configError.reason, 0n, Date.now(), null) };
    const n = asFiniteNumber(this.nowFn());
    if (n == null || (this.lastNow !== undefined && n < this.lastNow)) {
      const e = this.emit("blocked", ZERO_HASH, "BAD_NOW", 0n, Date.now(), null);
      return { ok: false, event: e };
    }
    this.lastNow = n;
    return { ok: true, now: n };
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

  queue(req: TimelockRequest): { ok: true; queued: boolean; earliest: number; event: QueueEvent } | { ok: false; event: QueueEvent } {
    const clock = this.readNow();
    if (!clock.ok) return { ok: false, event: clock.event };
    const now = clock.now;
    this.prune(now);
    if (!req || typeof req !== "object") {
      const ev = this.emit("blocked", ZERO_HASH, "MALFORMED", 0n, now, null);
      return { ok: false, event: ev };
    }
    const planId = lowerPlanId(req.planId);
    if (!planId) {
      const ev = this.emit("blocked", ZERO_HASH, "MALFORMED", asAmount(req.amount) ?? 0n, now, null);
      return { ok: false, event: ev };
    }
    const amount = asAmount(req.amount);
    if (amount == null) {
      const ev = this.emit("blocked", planId, "MALFORMED", 0n, now, planId);
      return { ok: false, event: ev };
    }
    if (typeof req.token !== "string" || !req.token || typeof req.kind !== "string" || !req.kind) {
      const ev = this.emit("blocked", planId, "MALFORMED", amount, now, planId);
      return { ok: false, event: ev };
    }
    if (this.seen.has(planId) || this.history.has(planId)) {
      const h = this.history.get(planId);
      const reason = h?.status === "consumed" ? "Consumed" : h?.status === "cancelled" ? "Cancelled" : h?.status === "expired" ? "Expired" : "Replay";
      const ev = this.emit("blocked", planId, reason, amount, now, planId);
      return { ok: false, event: ev };
    }
    let delay = this.delayMs;
    if ("delayMs" in req && req.delayMs !== undefined && req.delayMs !== null) {
      const d = positiveFinite(req.delayMs, TIMELOCK_DELAY_MAX_MS);
      if (d == null) {
        const ev = this.emit("blocked", planId, "BAD_CONFIG: delayMs", amount, now, planId);
        return { ok: false, event: ev };
      }
      delay = Math.min(d, this.delayMs);
    }
    const token = upperToken(req.token);
    if (!token) {
      const ev = this.emit("blocked", planId, "MALFORMED", amount, now, planId);
      return { ok: false, event: ev };
    }
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
    const clock = this.readNow();
    if (!clock.ok) return clock.event;
    const now = clock.now;
    this.prune(now);
    const planId = lowerPlanId(planIdRaw);
    if (!planId) return this.emit("blocked", ZERO_HASH, "MALFORMED", 0n, now, null);
    const row = this.rows.get(planId);
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!row) {
      const h = this.history.get(planId);
      return this.emit("blocked", planId, h ? (h.status === "consumed" ? "Consumed" : h.status === "cancelled" ? "Cancelled" : "NotCancellable") : "Unknown", h?.amount ?? 0n, now, planId);
    }
    const live = this.live(row, now);
    if (live.status !== "queued") {
      return this.emit("blocked", planId, live.status === "expired" ? "Expired" : "NotCancellable", live.amount, now, planId);
    }
    if (who !== live.requester && !this.isGuardian(who)) {
      return this.emit("blocked", planId, "Unauthorized", live.amount, now, planId);
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
    const clock = this.readNow();
    if (!clock.ok) return clock.event;
    const now = clock.now;
    this.prune(now);
    const planId = lowerPlanId(planIdRaw);
    if (!planId) return this.emit("blocked", ZERO_HASH, "MALFORMED", 0n, now, null);
    const amountProvided = o !== undefined && o !== null && typeof o === "object" && "amount" in o && o.amount !== undefined;
    const known = amountProvided ? asAmount(o.amount) : null;
    const row0 = this.rows.get(planId);
    const hist = this.history.get(planId);
    const fallbackAmt = row0?.amount ?? hist?.amount ?? 0n;
    if (this.paused) {
      return this.emit("blocked", planId, "paused", known ?? fallbackAmt, now, planId);
    }
    if (!amountProvided) {
      return this.emit("blocked", planId, "MissingAmount", fallbackAmt, now, planId);
    }
    if (known == null) {
      return this.emit("blocked", planId, "dati incompleti: amount", fallbackAmt, now, planId);
    }
    const amt = known;
    if (!row0) {
      const reason = hist ? (hist.status === "consumed" ? "Consumed" : hist.status === "cancelled" ? "Cancelled" : hist.status === "expired" ? "Expired" : "Replay") : (this.seen.has(planId) ? "Replay" : "Unknown");
      return this.emit("blocked", planId, reason, amt, now, planId);
    }
    const row = this.live(row0, now);
    if (row.status === "consumed") {
      return this.emit("blocked", planId, "Consumed", amt, now, planId);
    }
    if (row.status === "cancelled") {
      return this.emit("blocked", planId, "Cancelled", amt, now, planId);
    }
    if (row.status === "expired" || now > row.expiresAt) {
      this.remember({ ...row, status: "expired", decidedAt: now });
      return this.emit("expired", planId, "Expired", amt, now, planId);
    }
    if (now < row.earliest) {
      return this.emit("blocked", planId, "timelock_pending", amt, now, planId);
    }
    if (amt !== row.amount) {
      return this.emit("blocked", planId, "AmountMismatch", amt, now, planId);
    }
    this.remember({ ...row, status: "consumed", decidedAt: now, amount: amt });
    return this.emit("consumed", planId, "Consumed", amt, now, planId);
  }

  pause(by: string): QueueEvent {
    const clock = this.readNow();
    if (!clock.ok) return clock.event;
    const now = clock.now;
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!this.isGuardian(who)) {
      return this.emit("blocked", ZERO_HASH, "Unauthorized", 0n, now, null);
    }
    this.paused = true;
    this.unpauseAt = null;
    this.unpauseBy = null;
    return this.emit("blocked", ZERO_HASH, "paused", 0n, now, null);
  }

  /** Owner/guardian requests unpause; it becomes effective only after `unpauseDelayMs`. */
  requestUnpause(by: string): QueueEvent {
    const clock = this.readNow();
    if (!clock.ok) return clock.event;
    const now = clock.now;
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!this.isGuardian(who)) {
      return this.emit("blocked", ZERO_HASH, "Unauthorized", 0n, now, null);
    }
    if (!this.paused) {
      return this.emit("blocked", ZERO_HASH, "NotPaused", 0n, now, null);
    }
    this.unpauseAt = now + this.unpauseDelayMs;
    this.unpauseBy = who;
    return this.emit("queued", ZERO_HASH, "unpause_pending", 0n, now, null);
  }

  finalizeUnpause(by: string): QueueEvent {
    const clock = this.readNow();
    if (!clock.ok) return clock.event;
    const now = clock.now;
    const who = typeof by === "string" ? by.toLowerCase() : "";
    if (!this.isGuardian(who)) {
      return this.emit("blocked", ZERO_HASH, "Unauthorized", 0n, now, null);
    }
    if (!this.paused) {
      return this.emit("blocked", ZERO_HASH, "NotPaused", 0n, now, null);
    }
    if (this.unpauseAt === null) {
      return this.emit("blocked", ZERO_HASH, "unpause_pending", 0n, now, null);
    }
    if (now < this.unpauseAt) {
      return this.emit("blocked", ZERO_HASH, "unpause_pending", 0n, now, null);
    }
    this.paused = false;
    this.unpauseAt = null;
    this.unpauseBy = null;
    return this.emit("approved", ZERO_HASH, "Unpaused", 0n, now, null);
  }
}
