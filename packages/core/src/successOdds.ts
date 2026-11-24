/**
 * Success odds BEFORE paying (LemmaX idea). An ESTIMATE, not a guarantee.
 * Pure: no network, no keys, no signing. Ported from hunter-probabilita (eb94651).
 * - Missing or invalid data -> p = 0 "dati incompleti" (fail-closed).
 * - Config is validated first (finite, > 0) -> otherwise p = 0 "config non valida".
 * - Certain blocks (p = 0): dry-run `check()` refusal, wrong nonce, deadline passed, budget / weekly cap /
 *   signatures exhausted, not enough gas, expected out < minAmountOut, SAFE HOLD not PROCEED.
 * - Estimated risks: slippage margin vs volatility, time left vs latency, history of similar intents.
 */
import type { QueueEvent } from "./approvalQueue";

type IntLike = bigint | number | string;

export interface OddsPlan { swapAmount: IntLike; minAmountOut: IntLike; nonce: IntLike; deadline: number }
export interface OddsPool { reserveIn: IntLike; reserveOut: IntLike; feeBps?: IntLike }
export interface OddsState {
  now?: number; // unix seconds
  expectedNonce: IntLike;
  budgetRemaining: IntLike;
  weeklyCapRemaining: IntLike;
  signaturesRemaining: IntLike;
  signaturesNeeded?: IntLike; // optional: missing -> 1; present -> integer >= 1
  gasBalance: IntLike;
  gasNeeded: IntLike;
  pool: OddsPool;
}
export interface OddsConfig { volatilityPct: number; latencySec: number; minDeadlineSec: number }
export interface OddsInput {
  plan?: OddsPlan;
  state?: OddsState;
  dryRun?: Array<{ ok: boolean; reason?: string } | null>;
  history?: { ok: number; fail: number } | null;
  safeHold?: { decision: string; reasons?: Array<{ code?: string } | null> };
  config?: Partial<OddsConfig>;
}
export type OddsVerdict = "ALTA" | "MEDIA" | "BASSA" | "BLOCCATA";
export interface OddsFactor { id: string; label: string; p: number; detail: string }
export interface OddsResult { probability: number; verdict: OddsVerdict; factors: OddsFactor[]; note: string }

export const ODDS_DEFAULTS: Readonly<OddsConfig> = Object.freeze({ volatilityPct: 1, latencySec: 10, minDeadlineSec: 5 });

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export const clamp01 = (x: unknown): number => (num(x) ? Math.max(0, Math.min(1, x)) : 0);
/** Safe bigint: accepts bigint, safe-integer number, integer decimal string. Otherwise null. */
export function toBig(x: unknown): bigint | null {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return Number.isSafeInteger(x) ? BigInt(x) : null;
  if (typeof x === "string" && /^-?\d+$/.test(x.trim())) return BigInt(x.trim());
  return null;
}
const big = (x: unknown): bigint => {
  const b = toBig(x);
  if (b === null) throw new Error(`not an integer: ${String(x)}`);
  return b;
};

/** Expected out of a constant-product pool (x*y=k) with fee in bps. Invalid input -> 0n. */
export function expectedOut(amountIn: unknown, reserveIn: unknown, reserveOut: unknown, feeBps: unknown = 30): bigint {
  const a = toBig(amountIn), rIn = toBig(reserveIn), rOut = toBig(reserveOut), fee = toBig(feeBps);
  if (a === null || rIn === null || rOut === null || fee === null || fee < 0n || fee >= 10_000n) return 0n;
  if (a <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const aFee = a * (10_000n - fee);
  return (aFee * rOut) / (rIn * 10_000n + aFee);
}

const REQUIRED: Array<[string, (p: OddsInput) => boolean]> = [
  ["plan.swapAmount", (p) => (toBig(p.plan?.swapAmount) ?? 0n) > 0n],
  ["plan.minAmountOut", (p) => (toBig(p.plan?.minAmountOut) ?? -1n) >= 0n],
  ["plan.nonce", (p) => toBig(p.plan?.nonce) !== null],
  ["plan.deadline", (p) => num(p.plan?.deadline)],
  ["state.now", (p) => p.state?.now === undefined || num(p.state.now)],
  ["state.expectedNonce", (p) => toBig(p.state?.expectedNonce) !== null],
  ["state.budgetRemaining", (p) => toBig(p.state?.budgetRemaining) !== null],
  ["state.weeklyCapRemaining", (p) => toBig(p.state?.weeklyCapRemaining) !== null],
  ["state.signaturesNeeded", (p) => p.state?.signaturesNeeded === undefined || (toBig(p.state.signaturesNeeded) ?? 0n) >= 1n],
  ["state.signaturesRemaining", (p) => toBig(p.state?.signaturesRemaining) !== null],
  ["state.gasBalance", (p) => toBig(p.state?.gasBalance) !== null],
  ["state.gasNeeded", (p) => toBig(p.state?.gasNeeded) !== null],
  ["state.pool", (p) => !!p.state?.pool && toBig(p.state.pool.reserveIn) !== null && toBig(p.state.pool.reserveOut) !== null],
  ["dryRun", (p) => Array.isArray(p.dryRun) && p.dryRun.length > 0],
  ["safeHold", (p) => !!p.safeHold && typeof p.safeHold.decision === "string"],
];

export function estimateSuccess(input: OddsInput = {}): OddsResult {
  const p: OddsInput = input && typeof input === "object" ? input : {};
  const f: OddsFactor[] = [];
  const add = (id: string, label: string, prob: number, detail: string) => f.push({ id, label, p: clamp01(prob), detail });
  const finish = (): OddsResult => {
    const probability = clamp01(f.reduce((acc, x) => acc * x.p, 1));
    const blocked = f.length === 0 || f.some((x) => x.p === 0);
    const verdict: OddsVerdict = blocked ? "BLOCCATA" : probability >= 0.9 ? "ALTA" : probability >= 0.6 ? "MEDIA" : "BASSA";
    return { probability: blocked ? 0 : probability, verdict, factors: f, note: "Stima, non garanzia." };
  };

  // config first: finite and > 0, otherwise nothing is estimated
  const cfg: OddsConfig = { ...ODDS_DEFAULTS, ...(p.config && typeof p.config === "object" ? p.config : {}) };
  const badCfg = (Object.keys(ODDS_DEFAULTS) as Array<keyof OddsConfig>).filter((k) => !num(cfg[k]) || cfg[k] <= 0);
  if (badCfg.length) { add("config", "Configurazione valida", 0, `config non valida: ${badCfg.join(", ")}`); return finish(); }

  const missing = REQUIRED.filter(([, ok]) => { try { return !ok(p); } catch { return true; } }).map(([k]) => k);
  if (missing.length) { add("incomplete", "Dati completi per la stima", 0, `dati incompleti: ${missing.join(", ")}`); return finish(); }

  const plan = p.plan!, state = p.state!, dryRun = p.dryRun!, safeHold = p.safeHold!, history = p.history;
  const now = num(state.now) ? state.now : Math.floor(Date.now() / 1000);

  // --- certain blocks ---
  const bad = dryRun.filter((r) => !r || r.ok !== true);
  add("policy", "Le regole approvate permettono ogni passo", bad.length ? 0 : 1,
    bad.length ? `rifiutato: ${bad.map((r) => (r && r.reason) || "esito non ok").join("; ")}` : `${dryRun.length} passi ok nel dry-run`);
  add("nonce", "Numero d'ordine giusto", big(plan.nonce) === big(state.expectedNonce) ? 1 : 0, `piano ${plan.nonce}, atteso ${state.expectedNonce}`);
  const left = plan.deadline - now;
  if (left < cfg.minDeadlineSec) add("deadline", "C'è tempo prima della scadenza", 0, left <= 0 ? "piano già scaduto" : `restano solo ${left} s`);
  else add("deadline", "C'è tempo prima della scadenza", 1 - Math.exp(-left / cfg.latencySec), `restano ${left} s, conferma tipica ~${cfg.latencySec} s`);
  const amt = big(plan.swapAmount);
  add("budget", "Dentro il budget del piano", amt <= big(state.budgetRemaining) ? 1 : 0, `serve ${amt}, restano ${state.budgetRemaining}`);
  add("weekly", "Dentro il tetto settimanale", amt <= big(state.weeklyCapRemaining) ? 1 : 0, `serve ${amt}, restano ${state.weeklyCapRemaining}`);
  const need = state.signaturesNeeded === undefined ? 1n : big(state.signaturesNeeded);
  add("signatures", "Firme disponibili nel piano", big(state.signaturesRemaining) >= need ? 1 : 0, `servono ${need}, restano ${state.signaturesRemaining}`);
  add("gas", "Abbastanza gas", big(state.gasBalance) >= big(state.gasNeeded) ? 1 : 0, `saldo ${state.gasBalance}, servono ${state.gasNeeded}`);
  add("safehold", "Dati freschi e affidabili", safeHold.decision === "PROCEED" ? 1 : 0,
    safeHold.decision === "PROCEED" ? "SAFE HOLD ok"
      : `SAFE HOLD: ${(safeHold.reasons ?? []).map((r) => r?.code).filter(Boolean).join(", ") || safeHold.decision}`);
  // --- slippage ---
  const pool = state.pool;
  const out = expectedOut(amt, pool.reserveIn, pool.reserveOut, pool.feeBps ?? 30);
  const minOut = big(plan.minAmountOut);
  if (out === 0n || out < minOut) add("slippage", "Il prezzo attuale rispetta il minimo accettato", 0, `uscita attesa ${out} < minimo ${minOut}`);
  else {
    const marginPct = Number(((out - minOut) * 1_000_000n) / out) / 10_000;
    add("slippage", "Il prezzo attuale rispetta il minimo accettato", 1 - Math.exp(-marginPct / cfg.volatilityPct),
      `uscita attesa ${out}, minimo ${minOut}, margine ${marginPct.toFixed(2)}% vs volatilità ${cfg.volatilityPct}%`);
  }
  // --- history (Laplace (ok+1)/(n+2)), only integers >= 0 ---
  if (history !== undefined && history !== null) {
    const okN = history.ok, failN = history.fail;
    if (!(Number.isSafeInteger(okN) && Number.isSafeInteger(failN) && okN >= 0 && failN >= 0)) add("history", "Intent simili andati a buon fine", 0, "storico non valido");
    else add("history", "Intent simili andati a buon fine", (okN + 1) / (okN + failN + 2), `${okN} riusciti su ${okN + failN}`);
  }
  return finish();
}

/** Plain text to show before paying. */
export function formatOdds(r: OddsResult): string {
  const pct = Math.round(r.probability * 100);
  const worst = [...r.factors].sort((a, b) => a.p - b.p).filter((x) => x.p < 0.99).slice(0, 3);
  const head = r.verdict === "BLOCCATA" ? "Non pagare: questa operazione fallirebbe." : `Probabilità di riuscita stimata: ${pct}% (${r.verdict}).`;
  return [head, ...worst.map((x) => `- ${x.label}: ${Math.round(x.p * 100)}% (${x.detail})`), r.note].join("\n");
}

/**
 * Shared QueueEvent for a BLOCCATA result, reason "Odds:<factor ids at 0>". Null when not blocked.
 * A blocked result with an invalid planId/amount still produces an event (zero planId / 0n), never silence.
 */
export function oddsBlockedEvent(r: OddsResult, planId: string, amount: bigint, ts = new Date().toISOString()): QueueEvent | null {
  if (r.verdict !== "BLOCCATA") return null;
  const ok = typeof planId === "string" && /^0x[0-9a-fA-F]{64}$/.test(planId);
  const ids = r.factors.filter((x) => x.p === 0).map((x) => x.id);
  return {
    kind: "blocked",
    planId: (ok ? planId.toLowerCase() : `0x${"0".repeat(64)}`) as `0x${string}`,
    reason: `Odds:${ids.join(",") || "empty"}`,
    amount: typeof amount === "bigint" ? amount : 0n,
    ts,
    id: null,
  };
}
