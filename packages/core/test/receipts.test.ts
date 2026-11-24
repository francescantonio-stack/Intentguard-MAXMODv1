import { describe, expect, it } from "vitest";
import { receiptsFromEvents, ReceiptStore, type Receipt } from "../src/receipts";
import { blockedEvent } from "../src/guards";

const PID = ("0x" + "11".repeat(32)) as `0x${string}`;
const PID2 = ("0x" + "22".repeat(32)) as `0x${string}`;
const ORIG = ("0x" + "33".repeat(32)) as `0x${string}`;
const PAYER = "0x" + "ab".repeat(20);
const TS = "2026-11-24T05:35:00.000Z";
const TS2 = "2026-11-24T05:36:00.000Z";

const consumed = (extra: Record<string, unknown> = {}) => ({
  kind: "consumed",
  planId: PID,
  reason: "Consumed",
  amount: 10n,
  ts: TS,
  id: PID,
  payer: PAYER,
  token: "usdc",
  ...extra,
});

describe("ricevute da eventi", () => {
  it("consumed ed executed producono una ricevuta; blocked, rejected, expired no", () => {
    const { receipts, skipped } = receiptsFromEvents([
      consumed(),
      { kind: "executed", planId: PID2, reason: "Executed", amount: 4n, ts: TS2, id: PID2, payer: PAYER, token: "MON" },
      { kind: "blocked", planId: ORIG, reason: "paused", amount: 1n, ts: TS, id: ORIG, payer: PAYER, token: "USDC" },
      { kind: "rejected", planId: ("0x" + "44".repeat(32)), reason: "Cancelled", amount: 1n, ts: TS, id: null, payer: PAYER, token: "USDC" },
      { kind: "expired", planId: ("0x" + "55".repeat(32)), reason: "Expired", amount: 1n, ts: TS, id: null, payer: PAYER, token: "USDC" },
    ]);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toEqual({
      planId: PID.toLowerCase(),
      payer: PAYER,
      amount: 10n,
      token: "USDC",
      ts: TS,
    });
    expect(receipts[1]?.planId).toBe(PID2.toLowerCase());
    expect(receipts[1]?.token).toBe("MON");
    expect(receipts[1]?.amount).toBe(4n);
    expect(skipped.filter((s) => s.reason !== "no_receipt")).toEqual([]);
  });

  it("un rimborso porta refundOf verso il piano originale", () => {
    const refundId = ("0x" + "66".repeat(32)) as `0x${string}`;
    const { receipts } = receiptsFromEvents([
      { kind: "refunded", planId: refundId, reason: "Refund", amount: 10n, ts: TS2, id: refundId, payer: PAYER, token: "USDC", refundOf: ORIG.toUpperCase() },
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.refundOf).toBe(ORIG.toLowerCase());
    expect(receipts[0]?.planId).toBe(refundId.toLowerCase());
    expect(receipts[0]?.amount).toBe(10n);
  });

  it("niente ricevute duplicate per lo stesso planId, nemmeno tra due chiamate sullo store", () => {
    const store = new ReceiptStore();
    const first = receiptsFromEvents([consumed(), consumed({ ts: TS2 })], { store });
    expect(first.receipts).toHaveLength(1);
    expect(first.skipped.some((s) => s.reason === "duplicate")).toBe(true);
    const second = receiptsFromEvents([consumed({ ts: TS2 })], { store });
    expect(second.receipts).toHaveLength(0);
    expect(second.skipped).toEqual([{ event: consumed({ ts: TS2 }), reason: "duplicate" }]);
  });

  it("eventi malformati: skip + report, niente crash", () => {
    expect(() => receiptsFromEvents(null)).not.toThrow();
    const a = receiptsFromEvents(null);
    expect(a.receipts).toEqual([]);
    expect(a.skipped[0]?.reason).toBe("MALFORMED");
    const b = receiptsFromEvents([
      "nope",
      { kind: "consumed", planId: "0xzz", amount: 1n, ts: TS, payer: PAYER, token: "USDC" },
      { kind: "consumed", planId: PID, amount: "10", ts: TS, payer: PAYER, token: "USDC" },
      { kind: "consumed", planId: PID2, amount: 1n, ts: TS, payer: "0x" + "ab".repeat(32), token: "USDC" },
      { kind: "consumed", planId: ("0x" + "77".repeat(32)), amount: 1n, ts: TS, token: "USDC" },
    ]);
    expect(b.receipts).toEqual([]);
    expect(b.skipped.length).toBe(5);
    expect(b.skipped.every((s) => s.reason === "MALFORMED")).toBe(true);
  });

  it("ordine deterministico: ts poi planId; planId minuscolo, token maiuscolo, payer address minuscolo", () => {
    const laterSmall = consumed({ planId: PID2, ts: TS, token: "dai", payer: PAYER.toUpperCase() });
    const earlier = consumed({ planId: PID, ts: "2026-11-24T05:34:00.000Z", amount: 2n });
    const { receipts } = receiptsFromEvents([laterSmall, earlier]);
    expect(receipts.map((r) => r.planId)).toEqual([PID.toLowerCase(), PID2.toLowerCase()]);
    expect(receipts[0]!.ts < receipts[1]!.ts).toBe(true);
    expect(receipts[1]?.token).toBe("DAI");
    expect(receipts[1]?.payer).toBe(PAYER);
  });
});

describe("lezioni review: orologio, storico, config, blocked", () => {
  it("now non finito o all'indietro: BAD_NOW, nessuna ricevuta scritta nello store", () => {
    const store = new ReceiptStore();
    const ok = receiptsFromEvents([consumed()], { store, now: Date.parse(TS) });
    expect(ok.receipts).toHaveLength(1);
    expect(store.size).toBe(1);
    const bad = receiptsFromEvents([consumed({ planId: PID2, amount: 3n })], { store, now: Date.parse(TS) - 1 });
    expect(bad.receipts).toEqual([]);
    expect(bad.skipped[0]?.reason).toBe("BAD_NOW");
    expect(store.size).toBe(1);
    expect(store.has(PID2)).toBe(false);
    const nan = receiptsFromEvents([consumed({ planId: PID2, amount: 3n })], { store, now: NaN });
    expect(nan.receipts).toEqual([]);
    expect(nan.skipped[0]?.reason).toBe("BAD_NOW");
    expect(store.size).toBe(1);
  });

  it("remove e ricrea con lo stesso planId non azzera lo storico", () => {
    const store = new ReceiptStore();
    receiptsFromEvents([consumed()], { store, now: Date.parse(TS) });
    store.remove(PID);
    expect(store.has(PID)).toBe(true);
    const again = receiptsFromEvents([consumed({ ts: TS2 })], { store, now: Date.parse(TS2) });
    expect(again.receipts).toEqual([]);
    expect(again.skipped[0]?.reason).toBe("duplicate");
    expect(store.get(PID)?.ts).toBe(TS);
  });

  it("maxTtlMs presente ma non valido: BAD_CONFIG, niente scritti", () => {
    const store = new ReceiptStore();
    const r = receiptsFromEvents([consumed()], { store, maxTtlMs: NaN });
    expect(r.receipts).toEqual([]);
    expect(r.skipped[0]?.reason).toBe("BAD_CONFIG: maxTtlMs");
    expect(store.size).toBe(0);
  });

  it("blockedEvent emette un QueueEvent di kind blocked", () => {
    const ev = blockedEvent({ planId: PID, reason: "MALFORMED", amount: 7n, ts: TS, id: PID });
    expect(ev).toEqual({ kind: "blocked", planId: PID.toLowerCase(), reason: "MALFORMED", amount: 7n, ts: TS, id: PID });
    expect(typeof ev.amount).toBe("bigint");
  });

  it("un kind da rimborso o un evento con refundOf non viene saltato in silenzio", () => {
    const { receipts, skipped } = receiptsFromEvents([
      { kind: "refund_pending", planId: PID, reason: "Refund", amount: 10n, ts: TS, id: PID, payer: PAYER, token: "USDC", refundOf: ORIG },
      { kind: "blocked", planId: PID2, reason: "paused", amount: 1n, ts: TS, id: PID2, payer: PAYER, token: "USDC", refundOf: ORIG },
    ]);
    expect(receipts).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.reason === "unexpected_refund")).toBe(true);
    expect(skipped.every((s) => s.reason !== "no_receipt")).toBe(true);
  });

  it("importo negativo è rifiutato e finisce in skipped", () => {
    const { receipts, skipped } = receiptsFromEvents([
      consumed({ amount: -1n }),
    ]);
    expect(receipts).toEqual([]);
    expect(skipped).toEqual([{ event: consumed({ amount: -1n }), reason: "MALFORMED" }]);
  });

  it("maxTtlMs 7 giorni è accettato, 8 giorni dà BAD_CONFIG", () => {
    const d7 = 7 * 86_400_000;
    const d8 = 8 * 86_400_000;
    const ok = receiptsFromEvents([consumed()], { maxTtlMs: d7 });
    expect(ok.receipts).toHaveLength(1);
    const over = receiptsFromEvents([consumed()], { maxTtlMs: d8 });
    expect(over.receipts).toEqual([]);
    expect(over.skipped[0]?.reason).toBe("BAD_CONFIG: maxTtlMs");
  });

  it("token con spazi (' usdc ') è USDC", () => {
    const { receipts } = receiptsFromEvents([consumed({ token: " usdc " })]);
    expect(receipts[0]?.token).toBe("USDC");
  });

  it("now 1_000_000 poi 1_005_000 poi 1_000_500: non scrive e dà BAD_NOW", () => {
    const store = new ReceiptStore();
    const a = receiptsFromEvents([consumed()], { store, now: 1_000_000 });
    expect(a.receipts).toHaveLength(1);
    const b = receiptsFromEvents([consumed({ planId: PID2, ts: TS2 })], { store, now: 1_005_000 });
    expect(b.receipts).toHaveLength(1);
    const c = receiptsFromEvents([consumed({ planId: ("0x" + "44".repeat(32)), ts: TS })], { store, now: 1_000_500 });
    expect(c.receipts).toEqual([]);
    expect(c.skipped[0]?.reason).toBe("BAD_NOW");
    expect(store.size).toBe(2);
  });

  it("lookup di un id sconosciuto o malformato emette blocked e non lancia", () => {
    const store = new ReceiptStore();
    const unknown = store.lookup(PID, { now: Date.parse(TS) });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toBe("Unknown");
      expect(unknown.event.kind).toBe("blocked");
      expect(unknown.event.planId).toBe(PID.toLowerCase());
    }
    const bad = store.lookup("not-a-plan", { now: Date.parse(TS) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toBe("MALFORMED");
      expect(bad.event.kind).toBe("blocked");
      expect(bad.event.planId).toBe("0x" + "00".repeat(32));
      expect(JSON.stringify(bad.event, (_k, v) => typeof v === "bigint" ? v.toString() : v)).not.toContain("not-a-plan");
    }
  });

  it("una data ISO impossibile (2026-02-31) è MALFORMED, una data valida passa", () => {
    const bad = receiptsFromEvents([consumed({ ts: "2026-02-31T00:00:00.000Z" })]);
    expect(bad.receipts).toEqual([]);
    expect(bad.skipped[0]?.reason).toBe("MALFORMED");
    const rolled = new Date("2026-02-31T00:00:00.000Z").toISOString();
    expect(rolled).toBe("2026-03-03T00:00:00.000Z");
    const ok = receiptsFromEvents([consumed({ ts: "2026-11-24T05:35:00.000Z" })]);
    expect(ok.receipts).toHaveLength(1);
    expect(ok.receipts[0]?.ts).toBe("2026-11-24T05:35:00.000Z");
    const noMs = receiptsFromEvents([consumed({ planId: PID2, ts: "2026-11-24T05:35:00Z" })]);
    expect(noMs.receipts).toHaveLength(1);
  });
});

// type-level sanity: Receipt shape
const _keep: Receipt = { planId: PID, payer: PAYER, amount: 0n, token: "USDC", ts: TS };
void _keep;
