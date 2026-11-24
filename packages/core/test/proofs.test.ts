import { describe, expect, it } from "vitest";
import { proofPassed, verifyProofs, asFiniteNumber, asAmount, ProofStore, type ProofPlan, type Proof } from "../src/proofs";
import type { QueueEvent } from "../src/events";

const NOW = Date.parse("2026-11-24T05:35:00.000Z");
const PID = ("0x" + "ab".repeat(32)) as `0x${string}`;
const HASH = ("0x" + "cd".repeat(32)) as `0x${string}`;
const evs: QueueEvent[] = [];
const opts = (extra: Record<string, unknown> = {}) => {
  evs.length = 0;
  return { now: NOW, onEvent: (e: QueueEvent) => evs.push(e), ...extra };
};

const plan = (required: ProofPlan["required"], amount: bigint | number = 10n): ProofPlan => ({
  planId: PID, amount, required,
});

describe("prove obbligatorie", () => {
  it("tutte le prove valide: passa e amount è bigint", () => {
    const r = verifyProofs(
      plan([
        { type: "invoice_hash", expectedHash: HASH },
        { type: "counterparty_attestation", attester: "0xBob" },
        { type: "delivery_receipt" },
        { type: "simulation_passed" },
      ]),
      [
        { type: "invoice_hash", hash: HASH.toUpperCase() },
        { type: "counterparty_attestation", attester: "0xbob" },
        { type: "delivery_receipt", receiptId: "rcpt-1" },
        { type: "simulation_passed", ok: true },
      ],
      opts(),
    );
    expect(proofPassed(r)).toBe(true);
    if (!r.ok) return;
    expect(r.event.kind).toBe("consumed");
    expect(r.event.planId).toBe(PID.toLowerCase());
    expect(r.event.amount).toBe(10n);
  });

  it("prova mancante -> proof_missing", () => {
    const r = verifyProofs(plan([{ type: "invoice_hash", expectedHash: HASH }]), [], opts());
    expect(proofPassed(r)).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("proof_missing");
    expect(r.event.kind).toBe("blocked");
    expect(r.event.amount).toBe(10n);
  });

  it("hash sbagliato o tipo sbagliato -> proof_invalid", () => {
    const badHash = verifyProofs(plan([{ type: "invoice_hash", expectedHash: HASH }]), [{ type: "invoice_hash", hash: "0x" + "11".repeat(32) }], opts());
    expect(badHash.ok).toBe(false);
    if (!badHash.ok) expect(badHash.reason).toBe("proof_invalid");
    const wrongType = verifyProofs(plan([{ type: "invoice_hash", expectedHash: HASH }]), [{ type: "delivery_receipt", receiptId: "x" }], opts());
    if (!wrongType.ok) expect(wrongType.reason).toBe("proof_missing");
  });

  it("prova scaduta -> proof_expired", () => {
    const r = verifyProofs(
      plan([{ type: "delivery_receipt", expiresAt: NOW - 1 }]),
      [{ type: "delivery_receipt", receiptId: "r1" }],
      opts(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("proof_expired");
    const r2 = verifyProofs(
      plan([{ type: "counterparty_attestation", attester: "bob" }]),
      [{ type: "counterparty_attestation", attester: "bob", expiresAt: NOW - 5 }],
      opts(),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("proof_expired");
  });

  it("simulation_passed accetta solo ok === true", () => {
    for (const ok of [0, 1, "true", false, null, undefined]) {
      const r = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok } as Proof], opts());
      expect(proofPassed(r)).toBe(false);
    }
    expect(proofPassed(verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], opts()))).toBe(true);
  });
});

describe("fail-closed", () => {
  it("now NaN -> BAD_NOW, niente crash", () => {
    const r = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], { now: NaN, onEvent: (e) => evs.push(e) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("BAD_NOW");
      expect(r.event.kind).toBe("blocked");
      expect(Number.isFinite(Date.parse(r.event.ts))).toBe(true);
    }
  });

  it("plan null, proofs non array, amount stringa: blocco MALFORMED", () => {
    const a = verifyProofs(null, [], opts());
    expect(a.ok).toBe(false);
    if (!a.ok) { expect(a.reason).toBe("MALFORMED"); expect(a.event.kind).toBe("blocked"); }
    const b = verifyProofs(plan([{ type: "simulation_passed" }]), null, opts());
    expect(b.ok).toBe(false);
    if (!b.ok) { expect(b.reason).toBe("MALFORMED"); expect(b.event.kind).toBe("blocked"); }
    const c = verifyProofs({ planId: PID, amount: "10", required: [{ type: "simulation_passed" }] }, [{ type: "simulation_passed", ok: true }], opts());
    expect(c.ok).toBe(false);
    if (!c.ok) { expect(c.reason).toBe("MALFORMED"); expect(c.event.kind).toBe("blocked"); }
    expect(asFiniteNumber("0.1")).toBeUndefined();
    expect(asAmount(0n)).toBe(0n);
    expect(proofPassed({ ok: 0 })).toBe(false);
  });

  it("tipo di prova sconosciuto senza verifier extra -> proof_invalid", () => {
    const r = verifyProofs(plan([{ type: "kyc_badge" }]), [{ type: "kyc_badge" }], opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("proof_invalid");
  });

  it("verifier estendibile: un tipo nuovo può essere aggiunto", () => {
    const r = verifyProofs(
      plan([{ type: "kyc_badge" }]),
      [{ type: "kyc_badge" }],
      { ...opts(), verifiers: { kyc_badge: (_r, p) => (p ? "ok" : "proof_missing") } },
    );
    expect(proofPassed(r)).toBe(true);
  });

  it("expiresAt stringa è un tipo sbagliato e blocca", () => {
    const r = verifyProofs(
      plan([{ type: "delivery_receipt", expiresAt: "100" as never }]),
      [{ type: "delivery_receipt", receiptId: "r" }],
      opts(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("proof_invalid");
  });
});

describe("lezioni review: NO_REQUIRED, config, orologio, storico, tightening", () => {
  it("required vuoto o non-array: blocked NO_REQUIRED, mai un passaggio", () => {
    for (const required of [[], null, "invoice_hash", { type: "simulation_passed" }]) {
      const r = verifyProofs({ planId: PID, amount: 10n, required } as never, [{ type: "simulation_passed", ok: true }], opts());
      expect(proofPassed(r)).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("NO_REQUIRED");
        expect(r.event.kind).toBe("blocked");
        expect(r.event.amount).toBe(10n);
      }
    }
  });

  it("maxTtlMs presente ma non valido: blocked BAD_CONFIG: maxTtlMs", () => {
    for (const maxTtlMs of [NaN, 0, Infinity, -5]) {
      const r = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], opts({ maxTtlMs }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("BAD_CONFIG: maxTtlMs");
        expect(r.event.kind).toBe("blocked");
      }
    }
  });

  it("expiresAt dal dato può solo stringere il tetto, mai allargarlo", () => {
    // req expires far in the future, proof even farther, maxTtl 1s -> expired if we wait? at NOW, now+1000 is still future
    const rOk = verifyProofs(
      plan([{ type: "delivery_receipt", expiresAt: NOW + 60_000 }]),
      [{ type: "delivery_receipt", receiptId: "r", expiresAt: NOW + 1_000 }],
      opts({ maxTtlMs: 30_000 }),
    );
    expect(proofPassed(rOk)).toBe(true);
    // the proof tries to stay valid until NOW+1e12, the requirement tightens to NOW+1
    const rExp = verifyProofs(
      plan([{ type: "delivery_receipt", expiresAt: NOW + 1 }]),
      [{ type: "delivery_receipt", receiptId: "r", expiresAt: NOW + 1e12 }],
      opts({ now: NOW + 2 }),
    );
    expect(rExp.ok).toBe(false);
    if (!rExp.ok) expect(rExp.reason).toBe("proof_expired");
  });

  it("now all'indietro: BAD_NOW, nessuno stato scritto", () => {
    const store = new ProofStore();
    const r1 = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], opts({ store, now: NOW }));
    expect(proofPassed(r1)).toBe(true);
    expect(store.historyOf(PID)?.status).toBe("consumed");
    const size = store.size;
    const r2 = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], opts({ store, now: NOW - 1 }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toBe("BAD_NOW");
      expect(r2.event.kind).toBe("blocked");
      expect(Number.isFinite(Date.parse(r2.event.ts))).toBe(true);
    }
    expect(store.size).toBe(size);
    expect(store.historyOf(PID)?.status).toBe("consumed");
  });

  it("remove e ricrea con lo stesso planId non azzera lo storico", () => {
    const store = new ProofStore();
    const r1 = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], opts({ store }));
    expect(proofPassed(r1)).toBe(true);
    store.remove(PID);
    const r2 = verifyProofs(plan([{ type: "simulation_passed" }]), [{ type: "simulation_passed", ok: true }], opts({ store, now: NOW + 1 }));
    expect(proofPassed(r2)).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toBe("Consumed");
      expect(r2.event.kind).toBe("blocked");
    }
  });
});
