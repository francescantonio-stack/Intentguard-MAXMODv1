import { test } from "vitest";
import assert from "node:assert/strict";
import { estimateSuccess, expectedOut, formatOdds, oddsBlockedEvent } from "../src/successOdds";
import type { OddsResult } from "../src/successOdds";

const NOW = 1_800_000_000;
const pool = { reserveIn: 63_700_000n, reserveOut: 14_150_000_000_000_000_000n, feeBps: 30 }; // ~ MiniSwap USDC/WMON (6 e 18 dec)
const out1 = expectedOut(1_000_000n, pool.reserveIn, pool.reserveOut, 30);
const base = (): any => ({
  plan: { swapAmount: 1_000_000n, minAmountOut: (out1 * 95n) / 100n, nonce: 3, deadline: NOW + 300 },
  state: { now: NOW, expectedNonce: 3, budgetRemaining: 5_000_000n, weeklyCapRemaining: 20_000_000n, signaturesRemaining: 5, signaturesNeeded: 2, gasBalance: 10n ** 17n, gasNeeded: 10n ** 16n, pool },
  dryRun: [{ ok: true }, { ok: true }], history: { ok: 18, fail: 0 }, safeHold: { decision: "PROCEED" },
});

test("expectedOut: formula x*y=k con fee, impatto ~1.8% su 1 USDC", () => {
  assert.ok(out1 > 0n);
  const spot = (1_000_000n * pool.reserveOut) / pool.reserveIn;
  const loss = Number(((spot - out1) * 10_000n) / spot) / 100;
  assert.ok(loss > 1.5 && loss < 2.0, `perdita ${loss}%`);
  assert.equal(expectedOut(0n, 1n, 1n), 0n);
});
test("tutto ok -> ALTA", () => {
  const r = estimateSuccess(base());
  assert.equal(r.verdict, "ALTA"); assert.ok(r.probability >= 0.9 && r.probability < 1);
});
for (const [name, mut, id] of <Array<[string, (b: any) => void, string]>>[
  ["dry-run rifiutato", (b: any) => { b.dryRun[1] = { ok: false, reason: "recipient non in allowlist" }; }, "policy"],
  ["nonce sbagliato", (b: any) => { b.state.expectedNonce = 4; }, "nonce"],
  ["scaduto", (b: any) => { b.plan.deadline = NOW - 1; }, "deadline"],
  ["oltre budget", (b: any) => { b.state.budgetRemaining = 999_999n; }, "budget"],
  ["oltre tetto settimanale", (b: any) => { b.state.weeklyCapRemaining = 0n; }, "weekly"],
  ["firme esaurite", (b: any) => { b.state.signaturesRemaining = 1; }, "signatures"],
  ["gas insufficiente", (b: any) => { b.state.gasBalance = 1n; }, "gas"],
  ["minimo troppo alto", (b: any) => { b.plan.minAmountOut = out1 + 1n; }, "slippage"],
  ["SAFE HOLD", (b: any) => { b.safeHold = { decision: "HOLD", reasons: [{ code: "STALE" }] }; }, "safehold"],
]) test(`blocco certo: ${name} -> BLOCCATA, p=0`, () => {
  const b = base(); mut(b); const r = estimateSuccess(b);
  assert.equal(r.verdict, "BLOCCATA"); assert.equal(r.probability, 0);
  assert.equal(r.factors.find((x) => x.id === id)!.p, 0);
});
test("margine slippage stretto abbassa la probabilità", () => {
  const b = base(); b.plan.minAmountOut = (out1 * 9_980n) / 10_000n; // margine 0.2%
  const r = estimateSuccess(b);
  assert.notEqual(r.verdict, "BLOCCATA"); assert.ok(r.probability < 0.3, String(r.probability));
});
test("storico negativo abbassa la probabilità", () => {
  const b = base(); b.history = { ok: 1, fail: 9 };
  assert.ok(estimateSuccess(b).probability < 0.2);
});
test("senza piano -> BLOCCATA", () => { assert.equal(estimateSuccess({}).verdict, "BLOCCATA"); assert.equal(estimateSuccess().probability, 0); });
const incompleto = (r: OddsResult, campo: string) => { assert.equal(r.verdict, "BLOCCATA"); assert.equal(r.probability, 0); assert.match(r.factors[0]!.detail, new RegExp("dati incompleti.*" + campo.replace(".", "\\."))); };
for (const [campo, del] of <Array<[string, (b: any) => void]>>[
  ["dryRun", (b: any) => { delete b.dryRun; }], ["dryRun", (b: any) => { b.dryRun = []; }], ["dryRun", (b: any) => { b.dryRun = null; }],
  ["state.pool", (b: any) => { delete b.state.pool; }], ["state.expectedNonce", (b: any) => { delete b.state.expectedNonce; }],
  ["state.budgetRemaining", (b: any) => { delete b.state.budgetRemaining; }], ["state.weeklyCapRemaining", (b: any) => { delete b.state.weeklyCapRemaining; }],
  ["state.signaturesRemaining", (b: any) => { delete b.state.signaturesRemaining; }], ["state.gasBalance", (b: any) => { delete b.state.gasBalance; }],
  ["state.gasNeeded", (b: any) => { delete b.state.gasNeeded; }], ["safeHold", (b: any) => { delete b.safeHold; }],
  ["plan.swapAmount", (b: any) => { delete b.plan.swapAmount; }], ["plan.deadline", (b: any) => { delete b.plan.deadline; }],
  ["plan.deadline", (b: any) => { b.plan.deadline = "domani"; }], ["plan.deadline", (b: any) => { b.plan.deadline = NaN; }],
  ["state.now", (b: any) => { b.state.now = NaN; }], ["plan.swapAmount", (b: any) => { b.plan.swapAmount = "1.5"; }],
]) test(`dati incompleti (${campo}) -> p=0 BLOCCATA`, () => { const b = base(); del(b); incompleto(estimateSuccess(b), campo); });
test("firme esaurite come bigint 0n -> BLOCCATA", () => {
  const b = base(); b.state.signaturesRemaining = 0n; const r = estimateSuccess(b);
  assert.equal(r.verdict, "BLOCCATA"); assert.equal(r.factors.find((x) => x.id === "signatures")!.p, 0);
});
test("dry-run ok solo con ok === true", () => {
  for (const step of <any[]>[{ ok: 0 }, { success: false }, { ok: "true" }, {}, null]) {
    const b = base(); b.dryRun = [{ ok: true }, step]; assert.equal(estimateSuccess(b).verdict, "BLOCCATA");
  }
});
test("storico non valido (negativi, decimali) -> BLOCCATA", () => {
  for (const h of <any[]>[{ ok: -5, fail: 0 }, { ok: 3, fail: -1 }, { ok: 1.5, fail: 0 }, { ok: "3", fail: 0 }]) {
    const b = base(); b.history = h; assert.equal(estimateSuccess(b).verdict, "BLOCCATA");
  }
});
test("nonce normalizzato: stringa \"3\" == 3", () => {
  const b = base(); b.plan.nonce = "3"; assert.equal(estimateSuccess(b).verdict, "ALTA");
});
test("config non valida (NaN, Infinity, 0, negativa, stringa) -> BLOCCATA, mai NaN", () => {
  for (const config of <any[]>[{ volatilityPct: NaN }, { latencySec: Infinity }, { minDeadlineSec: 0 }, { volatilityPct: -1 }, { latencySec: "10" }]) {
    const b = base(); b.config = config; const r = estimateSuccess(b);
    assert.ok(!Number.isNaN(r.probability)); assert.equal(r.verdict, "BLOCCATA"); assert.equal(r.probability, 0);
    assert.match(r.factors[0]!.detail, /config non valida/);
  }
});
test("oddsBlockedEvent: QueueEvent solo se BLOCCATA, con planId minuscolo e amount bigint", () => {
  const PLAN = "0x" + "AB".repeat(32);
  assert.equal(oddsBlockedEvent(estimateSuccess(base()), PLAN, 1n), null);
  const b = base(); b.state.gasBalance = 1n; b.state.expectedNonce = 9;
  const e = oddsBlockedEvent(estimateSuccess(b), PLAN, 1_000_000n, "2027-01-15T08:00:00.000Z")!;
  assert.deepEqual(e, { kind: "blocked", planId: PLAN.toLowerCase(), reason: "Odds:nonce,gas", amount: 1_000_000n, ts: "2027-01-15T08:00:00.000Z", id: null });
  const e2 = oddsBlockedEvent(estimateSuccess({}), "0x12", 5 as unknown as bigint)!;
  assert.equal(e2.planId, "0x" + "0".repeat(64)); assert.equal(e2.amount, 0n); assert.equal(e2.reason, "Odds:incomplete");
});
test("formatOdds: testo semplice", () => {
  assert.match(formatOdds(estimateSuccess(base())), /Probabilità di riuscita stimata: \d+% \(ALTA\)/);
  const b = base(); b.state.gasBalance = 1n;
  const t = formatOdds(estimateSuccess(b));
  assert.match(t, /^Non pagare/); assert.match(t, /Abbastanza gas: 0%/); assert.match(t, /Stima, non garanzia/);
});

test("signaturesNeeded presente ma non valido -> dati incompleti; assente -> default 1", () => {
  for (const bad of <any[]>["foo", 1.5, 0, -1n, null, NaN]) {
    const r = estimateSuccess({ ...base(), state: { ...base().state, signaturesNeeded: bad } });
    assert.equal(r.probability, 0, `valore ${String(bad)}`);
    assert.match(r.factors.find((f) => f.id === "incomplete")!.detail, /signaturesNeeded/);
  }
  const { signaturesNeeded, ...st } = base().state;
  const ok = estimateSuccess({ ...base(), state: st });
  assert.ok(ok.probability > 0);
  assert.match(ok.factors.find((f) => f.id === "signatures")!.detail, /servono 1,/);
});
