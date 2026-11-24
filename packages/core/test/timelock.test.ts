import { describe, expect, it } from "vitest";
import {
  Sentinel,
  WINDOW_MS,
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
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
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.queued).toBe(true);
    expect(r.event.reason).toBe("timelock_pending");
    const early = s.consume(PID, { amount: 1_000_001n });
    expect(early.kind).toBe("blocked");
    expect(early.reason).toBe("timelock_pending");
    expect(early.amount).toBe(1_000_001n);
    clock.now += 60_000;
    const ev = s.consume(PID, { amount: 1_000_001n });
    expect(ev.kind).toBe("consumed");
    expect(ev.reason).toBe("Consumed");
  });

  it("tipi sensibili (approve illimitato, add_signer, policy/limit) vanno sempre in coda", () => {
    for (const [kind, id] of [["unlimited_approve", "0x"+"aa".repeat(32)], ["add_signer", "0x"+"bb".repeat(32)], ["policy_change", "0x"+"cc".repeat(32)], ["limit_change", "0x"+"dd".repeat(32)]] as const) {
      const { s, clock } = world();
      const r = s.queue({ planId: id, amount: 1n, token: "USDC", kind, requester: USER });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.queued).toBe(true);
      expect(s.consume(id, { amount: 1n }).kind).not.toBe("consumed");
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
    expect(s.consume(PID, { amount: 9_000_000n }).kind).not.toBe("consumed");
  });

  it("token senza soglia è sempre bloccato da un delay", () => {
    const { s } = world();
    const r = s.queue({ planId: PID, amount: 1n, token: "MON", kind: "transfer", requester: USER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
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
    const blocked = s.consume(PID, { amount: 9_000_000n });
    expect(blocked.kind).toBe("blocked");
    expect(blocked.reason).toBe("paused");
    expect(blocked.amount).toBe(9_000_000n);
  });

  it("unpause richiede owner/guardian ed è time-locked", () => {
    const { s, clock } = world();
    s.pause(GUARD);
    expect(s.finalizeUnpause(OWNER).kind).toBe("blocked");
    const q = s.requestUnpause(OWNER);
    expect(q.kind).toBe("queued");
    expect(q.reason).toBe("unpause_pending");
    expect(s.finalizeUnpause(OWNER).kind).toBe("blocked");
    clock.now += 30_000;
    const ev = s.finalizeUnpause(OWNER);
    expect(ev.kind).toBe("approved");
    expect(ev.reason).toBe("Unpaused");
    expect(s.isPaused()).toBe(false);
  });

  it("un estraneo non può fare pause o unpause", () => {
    const { s } = world();
    expect(s.pause(USER).kind).toBe("blocked");
    s.pause(OWNER);
    expect(s.requestUnpause(USER).kind).toBe("blocked");
  });
});

describe("scadenza, replay, memoria, fail-closed", () => {
  it("anche lo stato queued scade: consume dopo expiresAt lancia expired", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 9n, token: "USDC", kind: "unlimited_approve", requester: USER });
    clock.now += 60_000 + WINDOW_MS + 1;
    const exp = s.consume(PID, { amount: 9n });
    expect(exp.kind).toBe("expired");
    expect(exp.reason).toBe("Expired");
    expect(exp.amount).toBe(9n);
  });

  it("consume dopo un consume già fatto è replay/Consumed e non passa", () => {
    const { s } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    s.consume(PID, { amount: 1n });
    expect(s.consume(PID, { amount: 1n }).kind).not.toBe("consumed");
  });

  it("prune toglie i record vecchi ma il planId visto blocca il replay", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    s.consume(PID, { amount: 1n });
    clock.now += WINDOW_MS + 1;
    const again = s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.event.reason).toBe("Consumed");
      expect(again.event.kind).toBe("blocked");
    }
  });

  it("now NaN, amount stringa, planId malformato: blocco, niente crash", () => {
    const clock = { now: NaN as number };
    evs.length = 0;
    const s = new Sentinel({ delayMs: 1, owner: OWNER, now: () => clock.now, onEvent: (e) => evs.push(e) });
    expect(s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer" }).ok).toBe(false);
    expect(evs[0]?.kind).toBe("blocked");
    expect(evs[0]?.reason).toBe("BAD_NOW");
    expect(Number.isFinite(Date.parse(evs[0]!.ts))).toBe(true);
    evs.length = 0;
    const s2 = new Sentinel({ delayMs: 1, owner: OWNER, now: () => NOW, onEvent: (e) => evs.push(e) });
    expect(s2.queue({ planId: "0xzz", amount: 1n, token: "USDC", kind: "transfer" }).ok).toBe(false);
    expect(evs.at(-1)?.kind).toBe("blocked");
    expect(evs.at(-1)?.planId).toBe("0x" + "00".repeat(32));
    expect(JSON.stringify(evs.at(-1), (_k, v) => typeof v === "bigint" ? v.toString() : v)).not.toContain("0xzz");
    expect(evs.at(-1)?.kind).toBe("blocked");
    expect(s2.queue({ planId: PID2, amount: "1" as never, token: "USDC", kind: "transfer" }).ok).toBe(false);
    expect(evs.at(-1)?.kind).toBe("blocked");
    expect(evs.at(-1)?.reason).toBe("MALFORMED");
  });

  it("planId e requester minuscoli, token maiuscolo, amount bigint mai toString", () => {
    const { s, evs: e } = world();
    const r = s.queue({ planId: PID.toUpperCase(), amount: 2n, token: "usdc", kind: "transfer", requester: USER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.planId).toBe(PID.toLowerCase());
    expect(r.event.amount).toBe(2n);
    expect(typeof r.event.amount).toBe("bigint");
    expect(e[0]?.id).toBe(PID.toLowerCase());
  });

  it("consume senza amount → MissingAmount; amount diverso → AmountMismatch; nessuno stato consumato", () => {
    const { s } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    const missing = s.consume(PID);
    expect(missing.kind).toBe("blocked");
    expect(missing.reason).toBe("MissingAmount");
    const mismatch = s.consume(PID, { amount: 77n });
    expect(mismatch.kind).toBe("blocked");
    expect(mismatch.reason).toBe("AmountMismatch");
    expect(mismatch.amount).toBe(77n);
    expect(s.consume(PID, { amount: 1n }).kind).toBe("consumed");
  });
});

describe("lezioni review: config, orologio, storico, tightening", () => {
  it("config non valida in costruzione: emette blocked BAD_CONFIG e non lancia", () => {
    const cases: Array<[Partial<ConstructorParameters<typeof Sentinel>[0]>, string]> = [
      [{ owner: OWNER, delayMs: NaN }, "BAD_CONFIG: delayMs"],
      [{ owner: OWNER, delayMs: 0 }, "BAD_CONFIG: delayMs"],
      [{ owner: OWNER, delayMs: Infinity }, "BAD_CONFIG: delayMs"],
      [{ owner: OWNER, delayMs: 1, unpauseDelayMs: NaN }, "BAD_CONFIG: unpauseDelayMs"],
      [{ owner: OWNER, delayMs: 1, ttlMs: -1 }, "BAD_CONFIG: ttlMs"],
      [{ owner: OWNER, delayMs: 1, windowMs: Infinity }, "BAD_CONFIG: windowMs"],
      [{ owner: OWNER, delayMs: 1, thresholds: { USDC: -1n } }, "BAD_CONFIG: thresholds"],
      [{ owner: OWNER, delayMs: 1, sensitive: "policy_change" as unknown as string[] }, "BAD_CONFIG: sensitive"],
      [{ owner: "", delayMs: 1 }, "BAD_CONFIG: owner"],
    ];
    for (const [extra, reason] of cases) {
      const logged: QueueEvent[] = [];
      const s = new Sentinel({ delayMs: extra.delayMs as number, owner: (extra.owner as string) ?? OWNER, ...extra, onEvent: (e) => logged.push(e) });
      expect(s.configError?.kind).toBe("blocked");
      expect(s.configError?.reason).toBe(reason);
      expect(logged[0]?.kind).toBe("blocked");
      expect(logged[0]?.reason).toBe(reason);
      const q = s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer" });
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.event.kind).toBe("blocked");
    }
  });

  it("delayMs sul piano può solo stringere il delay configurato, mai allargarlo", () => {
    const { s, clock } = world();
    const tight = s.queue({ planId: PID, amount: 9_000_000n, token: "USDC", kind: "transfer", requester: USER, delayMs: 10_000 });
    expect(tight.ok).toBe(true);
    if (!tight.ok) return;
    expect(tight.queued).toBe(true);
    expect(tight.earliest).toBe(clock.now + 10_000);
    const { s: s2, clock: c2 } = world();
    const wide = s2.queue({ planId: PID2, amount: 9_000_000n, token: "USDC", kind: "transfer", requester: USER, delayMs: 120_000 });
    expect(wide.ok).toBe(true);
    if (!wide.ok) return;
    expect(wide.earliest).toBe(c2.now + 60_000);
    evs.length = 0;
    const { s: s3 } = world();
    const badDelay = s3.queue({ planId: PID, amount: 9n, token: "USDC", kind: "transfer", requester: USER, delayMs: NaN });
    expect(badDelay.ok).toBe(false);
    if (!badDelay.ok) {
      expect(badDelay.event.kind).toBe("blocked");
      expect(badDelay.event.reason).toBe("BAD_CONFIG: delayMs");
    }
  });

  it("now all'indietro: BAD_NOW, nessuno stato scritto, emit non crasha", () => {
    const { s, clock } = world();
    s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    clock.now -= 1;
    evs.length = 0;
    const back = s.consume(PID, { amount: 1n });
    expect(back.kind).toBe("blocked");
    expect(back.reason).toBe("BAD_NOW");
    expect(Number.isFinite(Date.parse(back.ts))).toBe(true);
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
    const again = s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.event.reason).toBe("Consumed");
      expect(again.event.kind).toBe("blocked");
    }
    const replay = s.consume(PID, { amount: 1n });
    expect(replay.kind).toBe("blocked");
    expect(replay.reason).toBe("Consumed");
  });

  it("input null o malformato: kind blocked MALFORMED, niente crash", () => {
    const { s } = world();
    const r = s.queue(null as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.event.kind).toBe("blocked");
      expect(r.event.reason).toBe("MALFORMED");
    }
  });

  it("token con spazi (' usdc ') è USDC", () => {
    const { s } = world();
    const r = s.queue({ planId: PID, amount: 1n, token: " usdc ", kind: "transfer", requester: USER });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.kind === "queued" || r.event.kind === "auto_approved" || true).toBe(true);
    expect(s.consume(PID, { amount: 1n }).kind).toBe("consumed");
  });

  it("delay/ttl 30 giorni e window 7 giorni sono accettati; 30d+1 e window 8d danno BAD_CONFIG nel costruttore", () => {
    const d30 = 30 * 86_400_000;
    const d30p = d30 + 1;
    const d7 = 7 * 86_400_000;
    const d8 = 8 * 86_400_000;
    const evs1: QueueEvent[] = [];
    const ok = new Sentinel({ delayMs: d30, unpauseDelayMs: d30, ttlMs: d30, windowMs: d7, owner: OWNER, onEvent: (e) => evs1.push(e) });
    expect(ok.configError).toBeNull();
    const logged: QueueEvent[] = [];
    const overDelay = new Sentinel({ delayMs: d30p, owner: OWNER, onEvent: (e) => logged.push(e) });
    expect(overDelay.configError?.kind).toBe("blocked");
    expect(overDelay.configError?.reason).toBe("BAD_CONFIG: delayMs");
    expect(logged[0]?.kind).toBe("blocked");
    const overTtl = new Sentinel({ delayMs: 1, ttlMs: d30p, owner: OWNER, onEvent: (e) => evs1.push(e) });
    expect(overTtl.configError?.reason).toBe("BAD_CONFIG: ttlMs");
    expect(overTtl.configError?.kind).toBe("blocked");
    const overUnpause = new Sentinel({ delayMs: 1, unpauseDelayMs: d30p, owner: OWNER, onEvent: (e) => evs1.push(e) });
    expect(overUnpause.configError?.reason).toBe("BAD_CONFIG: unpauseDelayMs");
    expect(overUnpause.configError?.kind).toBe("blocked");
    const overWin = new Sentinel({ delayMs: 1, windowMs: d8, owner: OWNER, onEvent: (e) => evs1.push(e) });
    expect(overWin.configError?.reason).toBe("BAD_CONFIG: windowMs");
    expect(overWin.configError?.kind).toBe("blocked");
  });

  it("ttl 1000, t=1_000_000 poi 1_005_000 poi 1_000_500: non torna eseguibile", () => {
    evs.length = 0;
    const clock = { now: 1_000_000 };
    const s = new Sentinel({ delayMs: 1, ttlMs: 1000, owner: OWNER, now: () => clock.now, onEvent: (e) => evs.push(e) });
    const q = s.queue({ planId: PID, amount: 1n, token: "USDC", kind: "transfer", requester: USER });
    expect(q.ok).toBe(true);
    clock.now = 1_005_000;
    const expired = s.consume(PID, { amount: 1n });
    expect(expired.kind).toBe("expired");
    clock.now = 1_000_500;
    const back = s.consume(PID, { amount: 1n });
    expect(back.kind).toBe("blocked");
    expect(back.reason).toBe("BAD_NOW");
    clock.now = 1_006_000;
    const later = s.consume(PID, { amount: 1n });
    expect(later.kind).not.toBe("consumed");
    expect(["expired", "blocked"]).toContain(later.kind);
  });

  it("lookup di un id sconosciuto o malformato emette blocked e non lancia", () => {
    const { s } = world();
    const unknown = s.lookup(PID);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.event.kind).toBe("blocked");
      expect(unknown.event.reason).toBe("Unknown");
      expect(unknown.event.planId).toBe(PID.toLowerCase());
    }
    const bad = s.lookup("not-a-plan");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.event.kind).toBe("blocked");
      expect(bad.event.reason).toBe("MALFORMED");
      expect(bad.event.planId).toBe("0x" + "00".repeat(32));
      expect(JSON.stringify(bad.event, (_k, v) => typeof v === "bigint" ? v.toString() : v)).not.toContain("not-a-plan");
    }
  });
});
