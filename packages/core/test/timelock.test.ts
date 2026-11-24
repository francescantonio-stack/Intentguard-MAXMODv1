import { describe, expect, it } from "vitest";
import {
  Sentinel,
  SentinelError,
  WINDOW_MS,
  asAmount,
  asFiniteNumber,
} from "../src/timelock";
import type { QueueEvent } from "../src/events";

const NOW = Date.parse("2026-11-24T05:35:00.000Z");
const PID = ("0x" + "11".repeat(32)) as `0x${string}`;
const PID2 = ("0x" + "22".repeat(32)) as `0x${string}`;
const OWNER = "0xOwner";
const GUARD = "0xGuard";
const USER = "0xUser";

const evs: QueueEvent[] = [];

function world(now0 = NOW, extra: Partial<ConstructorParameters<typeof Sentinel>[0]> = {}) {
  evs.length = 0;
  const clock = { now: now0 };
  const s = new Sentinel({
    delayMs: 60_000,
    unpauseDelayMs: 30_000,
    thresholds: { USDC: 1_000_000n },
    owner: OWNER,
    guardians: [GUARD],
    now: () => clock.now,
    onEvent: (e) => evs.push(e),
    ...extra,
  });
  return { s, clock, evs };
}

describe("time-lock", () => {
  it("sotto soglia e non sensibile: earliest = now, consume subito ok", () => {
    const { s, clock } = world();
    const r = s.queue({ planId: PID, amount: 1_000_000n, token: "usdc", kind: "transfer", requester: USER });
    expect(r.queued).toBe(false);
    expect(r.earliest).toBe(clock.now);
    expect(r.event.kind).toBe("queued");
    expect(r.event.amount).toBe(1_000_000n);
    expect(r.event.planId).toBe(PID);
    const ev = s.consume(PID, { amount: 1_000_000n });
    expect(ev.kind).toBe("consumed");
    expect(ev.amount).toBe(1_000_000n);
  });

  it("sopra soglia: execute troppo presto fallisce, dopo il delay funziona", () => {
    const { s, clock } = world();
    const r = s.queue({ planId: PID, amount: 1_000_001n, token: "USDC", kind: "transfer", requester: USER });
    expect(r.queued).toBe(true);
    expect(r.event.reason).toBe("timelock_pending");
    expect(() => s.consume(PID, { amount: 1_000_001n })).toThrow(SentinelError);
    try { s.consume(PID, { amount: 1_000_001n }); } catch (e) {
      expect((e as SentinelError).code).toBe("timelock_pending");
      expect((e as SentinelError).event.kind).toBe("blocked");
      expect((e as SentinelError).event.amount).toBe(1_000_001n);
    }
    clock.now += 60_000;
    const ev = s.consume(PID, { amount: 1_000_001n });
    expect(ev.kind).toBe("consumed");
    expect(ev.reason).toBe("Consumed");
  });

  it("tipi sensibili (approve illimitato, add_signer, policy/limit) vanno sempre in coda", () => {
    for (const [kind, id] of [["unlimited_approve", "0x"+"aa".repeat(32)], ["add_signer", "0x"+"bb".repeat(32)], ["policy_change", "0x"+"cc".repeat(32)], ["limit_change", "0x"+"dd".repeat(32)]] as const) {
      const { s, clock } = world();
      const r = s.queue({ planId: id, amount: 1n, token: "USDC", kind, requester: USER });
      expect(r.queued).toBe(true);
      expect(() => s.consume(id, { amount: 1n })).toThrow();
      clock.now += 60_000;
      expect(s.consume(id, { amount: 1n }).kind).toBe("consumed");
    }
  });

  it("si può cancellare durante l'attesa, non dopo consume", () => {
    const { s } = world();
    s.queue({ planId: PID, amount: 9_000_000n, token: "USDC", kind: "transfer", requester: USER });
    const ev = s.cancel(PID, USER);
    expect(ev.kind).toBe("rejected");
    expect(ev.reason).toBe("Cancelled");
    expect(() => s.consume(PID, { amount: 9_000_000n })).toThrow(SentinelError);
  });

  it("token senza soglia è sempre bloccato da un delay", () => {
    const { s } = world();
    const r = s.queue({ planId: PID, amount: 1n, token: "MON", kind: "transfer", requester: USER });
    expect(r.queued).toBe(true);
  });
});

describe("kill switch", () => {
  it("pause blocca anche gli item già in coda, anche dopo il delay", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 9_000_000n, token: "USDC", kind: "transfer", requester: USER });
    clock.now += 60_000;
    const ev = s.pause(OWNER);
    expect(ev.kind).toBe("blocked");
    expect(ev.reason).toBe("paused");
    expect(s.isPaused()).toBe(true);
    try { s.consume(PID, { amount: 9_000_000n }); } catch (e) {
      expect((e as SentinelError).code).toBe("paused");
      expect((e as SentinelError).event.kind).toBe("blocked");
      expect((e as SentinelError).event.reason).toBe("paused");
      expect((e as SentinelError).event.amount).toBe(9_000_000n);
    }
  });

  it("unpause richiede owner/guardian ed è time-locked", () => {
    const { s, clock } = world();
    s.pause(GUARD);
    expect(() => s.finalizeUnpause(OWNER)).toThrow();
    const q = s.requestUnpause(OWNER);
    expect(q.kind).toBe("queued");
    expect(q.reason).toBe("unpause_pending");
    expect(() => s.finalizeUnpause(OWNER)).toThrow(SentinelError);
    clock.now += 30_000;
    const ev = s.finalizeUnpause(OWNER);
    expect(ev.kind).toBe("approved");
    expect(ev.reason).toBe("Unpaused");
    expect(s.isPaused()).toBe(false);
  });

  it("un estraneo non può fare pause o unpause", () => {
    const { s } = world();
    expect(() => s.pause(USER)).toThrow(SentinelError);
    s.pause(OWNER);
    expect(() => s.requestUnpause(USER)).toThrow(SentinelError);
  });
});

describe("scadenza, replay, memoria, fail-closed", () => {
  it("anche lo stato queued scade: consume dopo expiresAt lancia expired", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 9n, token: "USDC", kind: "unlimited_approve", requester: USER });
    clock.now += 60_000 + WINDOW_MS + 1;
    try { s.consume(PID, { amount: 9n }); } catch (e) {
      expect((e as SentinelError).code).toBe("Expired");
      expect((e as SentinelError).event.kind).toBe("expired");
      expect((e as SentinelError).event.amount).toBe(9n);
    }
  });

  it("consume dopo un consume già fatto è replay/Consumed e non passa", () => {
    const { s } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    s.consume(PID, { amount: 1n });
    expect(() => s.consume(PID, { amount: 1n })).toThrow(SentinelError);
  });

  it("prune toglie i record vecchi ma il planId visto blocca il replay", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    s.consume(PID, { amount: 1n });
    clock.now += WINDOW_MS + 1;
    try {
      s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("Consumed");
      expect((e as SentinelError).event.kind).toBe("blocked");
    }
  });

  it("now NaN, amount stringa, planId malformato: blocco, niente crash", () => {
    expect(asFiniteNumber("0.1")).toBeUndefined();
    expect(asAmount("1")).toBeUndefined();
    expect(asAmount(0n)).toBe(0n);
    const clock = { now: NaN as number };
    evs.length = 0;
    const s = new Sentinel({ delayMs: 1, owner: OWNER, now: () => clock.now, onEvent: (e) => evs.push(e) });
    expect(() => s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer" })).toThrow(SentinelError);
    expect(evs[0]?.kind).toBe("blocked");
    expect(evs[0]?.reason).toBe("BAD_NOW");
    expect(Number.isFinite(Date.parse(evs[0]!.ts))).toBe(true);
    evs.length = 0;
    const s2 = new Sentinel({ delayMs: 1, owner: OWNER, now: () => NOW, onEvent: (e) => evs.push(e) });
    expect(() => s2.queue({ planId: "0xzz", amount: 1n, token: "USDC", kind: "transfer" })).toThrow();
    expect(evs.at(-1)?.kind).toBe("blocked");
    expect(() => s2.queue({ planId: PID2, amount: "1" as never, token: "USDC", kind: "transfer" })).toThrow();
    expect(evs.at(-1)?.kind).toBe("blocked");
    expect(evs.at(-1)?.reason).toBe("MALFORMED");
  });

  it("planId e requester minuscoli, token maiuscolo, amount bigint mai toString", () => {
    const { s, evs: e } = world();
    const r = s.queue({ planId: PID.toUpperCase(), amount: 2n, token: "usdc", kind: "transfer", requester: USER });
    expect(r.event.planId).toBe(PID.toLowerCase());
    expect(r.event.amount).toBe(2n);
    expect(typeof r.event.amount).toBe("bigint");
    expect(e[0]?.id).toBe(PID.toLowerCase());
  });

  it("consume senza amount → MissingAmount; amount diverso → AmountMismatch; nessuno stato consumato", () => {
    const { s } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    try {
      s.consume(PID);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("MissingAmount");
      expect((e as SentinelError).event.kind).toBe("blocked");
    }
    try {
      s.consume(PID, { amount: 77n });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("AmountMismatch");
      expect((e as SentinelError).event.kind).toBe("blocked");
      expect((e as SentinelError).event.amount).toBe(77n);
    }
    expect(s.consume(PID, { amount: 1n }).kind).toBe("consumed");
  });
});

describe("lezioni review: config, orologio, storico, tightening", () => {
  it("config non valida in costruzione: throw BAD_CONFIG e evento kind blocked", () => {
    const cases: Array<[Partial<ConstructorParameters<typeof Sentinel>[0]>, string]> = [
      [{ owner: OWNER, delayMs: NaN }, "BAD_CONFIG: delayMs"],
      [{ owner: OWNER, delayMs: 0 }, "BAD_CONFIG: delayMs"],
      [{ owner: OWNER, delayMs: Infinity }, "BAD_CONFIG: delayMs"],
      [{ owner: OWNER, delayMs: 1, unpauseDelayMs: NaN }, "BAD_CONFIG: unpauseDelayMs"],
      [{ owner: OWNER, delayMs: 1, ttlMs: -1 }, "BAD_CONFIG: ttlMs"],
      [{ owner: OWNER, delayMs: 1, windowMs: Infinity }, "BAD_CONFIG: windowMs"],
      [{ owner: OWNER, delayMs: 1, thresholds: { USDC: -1n } }, "BAD_CONFIG: thresholds"],
      [{ owner: "", delayMs: 1 }, "BAD_CONFIG: owner"],
    ];
    for (const [extra, reason] of cases) {
      const logged: QueueEvent[] = [];
      try {
        new Sentinel({ delayMs: extra.delayMs as number, owner: (extra.owner as string) ?? OWNER, ...extra, onEvent: (e) => logged.push(e) });
        throw new Error(`expected throw for ${reason}`);
      } catch (e) {
        expect(e).toBeInstanceOf(SentinelError);
        expect((e as SentinelError).code).toBe("BAD_CONFIG");
        expect((e as SentinelError).event.kind).toBe("blocked");
        expect((e as SentinelError).event.reason).toBe(reason);
        expect(logged[0]?.kind).toBe("blocked");
      }
    }
  });

  it("delayMs sul piano può solo stringere il delay configurato, mai allargarlo", () => {
    const { s, clock } = world();
    const tight = s.queue({ planId: PID, amount: 9_000_000n, token: "USDC", kind: "transfer", requester: USER, delayMs: 10_000 });
    expect(tight.queued).toBe(true);
    expect(tight.earliest).toBe(clock.now + 10_000);
    const { s: s2, clock: c2 } = world();
    const wide = s2.queue({ planId: PID2, amount: 9_000_000n, token: "USDC", kind: "transfer", requester: USER, delayMs: 120_000 });
    expect(wide.earliest).toBe(c2.now + 60_000);
    evs.length = 0;
    const { s: s3 } = world();
    try {
      s3.queue({ planId: PID, amount: 9n, token: "USDC", kind: "transfer", requester: USER, delayMs: NaN });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).event.kind).toBe("blocked");
      expect((e as SentinelError).event.reason).toBe("BAD_CONFIG: delayMs");
    }
  });

  it("now all'indietro: BAD_NOW, nessuno stato scritto, emit non crasha", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    clock.now -= 1;
    evs.length = 0;
    try {
      s.consume(PID, { amount: 1n });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("BAD_NOW");
      expect((e as SentinelError).event.kind).toBe("blocked");
      expect(Number.isFinite(Date.parse((e as SentinelError).event.ts))).toBe(true);
    }
    clock.now += 2;
    expect(s.consume(PID, { amount: 1n }).kind).toBe("consumed");
  });

  it("remove e ricrea con lo stesso planId non azzera lo storico", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    s.consume(PID, { amount: 1n });
    expect(s.historyOf(PID)?.status).toBe("consumed");
    s.remove(PID);
    clock.now += 1;
    try {
      s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("Consumed");
      expect((e as SentinelError).event.kind).toBe("blocked");
    }
    try {
      s.consume(PID, { amount: 1n });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).code).toBe("Consumed");
      expect((e as SentinelError).event.kind).toBe("blocked");
    }
  });

  it("input null o malformato: kind blocked MALFORMED, niente crash", () => {
    const { s } = world();
    try {
      s.queue(null as never);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as SentinelError).event.kind).toBe("blocked");
      expect((e as SentinelError).event.reason).toBe("MALFORMED");
    }
  });
});
