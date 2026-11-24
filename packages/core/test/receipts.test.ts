import { describe, expect, it } from "vitest";
import { receiptsFromEvents, ReceiptStore, asAmount, asFiniteNumber, type Receipt } from "../src/receipts";
import { blockedEvent } from "../src/events";

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
    expect(asFiniteNumber("0.1")).toBeUndefined();
    expect(asAmount(0n)).toBe(0n);
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
});

// type-level sanity: Receipt shape
const _keep: Receipt = { planId: PID, payer: PAYER, amount: 0n, token: "USDC", ts: TS };
void _keep;
