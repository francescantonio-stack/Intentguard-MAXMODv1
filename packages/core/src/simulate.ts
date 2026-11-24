import {
  decodeErrorResult, decodeFunctionData, getAddress, isAddress, maxUint256, stringToHex,
  type Abi, type Address, type Hex,
} from "viem";
import { erc20Abi, planExecutorAbi } from "./abi";
import { redactSecrets } from "./redact";
import { blockedEvent, normalizeAddress, normalizePlanId, type QueueEvent } from "./events";
import { tightenBigint } from "./limits";

/**
 * Pre-sign simulation (idea: MonadLens). READ-ONLY: eth_call + eth_estimateGas + eth_getBalance.
 * Never signs, never sends. Every number carries its source (see `Sourced`).
 * Fail-closed: missing or invalid input returns ok:false with a reason — never throws, never a silent ok.
 *
 * Limits: decodes only the TOP-LEVEL calldata (ERC20 transfer/transferFrom/approve). Internal transfers made by
 * other contracts are not traced (Monad testnet public RPC has no debug_traceCall).
 */

/** A number plus where it came from (idea: PurpleIris). */
export type Sourced<T> = { value: T; source: string };

export type ProposedTx = { chainId: number; from: Address; to: Address; data?: Hex; value?: bigint };

/** Default threshold for the unlimited-approve warning. Input may only lower it. */
export const SIM_DEFAULTS = { unlimitedApproveMin: maxUint256 / 2n } as const;

export type SimOptions = {
  rpcLabel?: string;
  now?: number;
  config?: { unlimitedApproveMin?: unknown };
};

/** Minimal JSON-RPC surface: a viem PublicClient fits; tests pass a stub (no network). */
export type SimClient = {
  call: (a: { account: Address; to: Address; data?: Hex; value?: bigint }) => Promise<{ data?: Hex }>;
  estimateGas: (a: { account: Address; to: Address; data?: Hex; value?: bigint }) => Promise<bigint>;
  getBalance: (a: { address: Address }) => Promise<bigint>;
  getGasPrice?: () => Promise<bigint>;
};

export type TokenEffect =
  | { kind: "transfer"; token: Address; from: Address; to: Address; amount: Sourced<bigint> }
  | { kind: "approve"; token: Address; owner: Address; spender: Address; amount: Sourced<bigint>; unlimited: boolean };

export type Warning = { code: "UNLIMITED_APPROVE" | "UNKNOWN_CALLDATA" | "GAS_PRICE_UNKNOWN"; detail: string };

export type SimulationResult = {
  ok: boolean;
  chainId: number;
  from?: Address;
  to?: Address;
  revert?: { reason: string; raw?: Hex };
  gas?: Sourced<bigint>;
  gasPrice?: Sourced<bigint>;
  nativeBalanceBefore?: Sourced<bigint>;
  /** Estimated change of the sender's native balance: -(value) - gas*gasPrice. Negative = spent. */
  nativeDelta: Sourced<bigint>;
  tokenEffects: TokenEffect[];
  warnings: Warning[];
  lines: string[];
  simulatedAt: number;
};

/** Success is only `ok === true`. `{ok:0}`, `{success:false}` and missing ok all count as failure. */
export const simSucceeded = (sim: unknown): boolean =>
  !!sim && typeof sim === "object" && (sim as { ok?: unknown }).ok === true;

const ERRORS_ABI = [
  ...planExecutorAbi.filter((x) => x.type === "error"),
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
] as Abi;

const blocked = (reason: string, extra: Partial<SimulationResult> = {}): SimulationResult => ({
  chainId: extra.chainId ?? 0,
  from: extra.from,
  to: extra.to,
  nativeDelta: extra.nativeDelta ?? { value: 0n, source: "nessun effetto: input o simulazione non validi" },
  tokenEffects: extra.tokenEffects ?? [],
  warnings: extra.warnings ?? [],
  lines: extra.lines ?? [`❌ Blocco: ${reason}`],
  simulatedAt: extra.simulatedAt ?? Date.now(),
  nativeBalanceBefore: extra.nativeBalanceBefore,
  gas: extra.gas,
  gasPrice: extra.gasPrice,
  ok: false,
  revert: extra.revert ?? { reason },
});

/** Parse a required integer (accepts bigint, incl. 0n, and numeric strings). Rejects NaN/Infinity/null. */
export function parseCount(x: unknown, field: string): { ok: true; value: bigint } | { ok: false; reason: string } {
  if (typeof x === "bigint") return { ok: true, value: x };
  if (typeof x === "number") {
    if (!Number.isFinite(x) || !Number.isInteger(x)) return { ok: false, reason: `BAD_VALUE: ${field} non è un intero finito` };
    return { ok: true, value: BigInt(x) };
  }
  if (typeof x === "string" && (/^-?\d+$/.test(x.trim()) || /^0x[0-9a-fA-F]+$/.test(x.trim()))) {
    try { return { ok: true, value: BigInt(x.trim()) }; }
    catch { return { ok: false, reason: `BAD_VALUE: ${field} non convertibile` }; }
  }
  return { ok: false, reason: `BAD_VALUE: ${field} mancante o non valido` };
}

export function parseAddr(x: unknown, field: string): { ok: true; value: Address } | { ok: false; reason: string } {
  if (typeof x !== "string" || !isAddress(x)) return { ok: false, reason: `BAD_ADDRESS: ${field} non è un indirizzo` };
  try {
    getAddress(x); // validates checksum if mixed-case
    return { ok: true, value: normalizeAddress(x) as Address };
  } catch { return { ok: false, reason: `BAD_ADDRESS: ${field} checksum non valido` }; }
}

/** Pull revert data / message out of a viem (or raw JSON-RPC) error. */
export function revertReason(e: unknown): { reason: string; raw?: Hex } {
  let raw: Hex | undefined;
  let msg: string | undefined;
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 8; cur = (cur as { cause?: unknown }).cause, i++) {
    const c = cur as { data?: { data?: unknown } | unknown; reason?: unknown; shortMessage?: unknown; message?: unknown };
    const d = (c.data && typeof c.data === "object" && "data" in c.data ? (c.data as { data?: unknown }).data : c.data);
    if (!raw && typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d) && d.length >= 10) raw = d as Hex;
    if (!msg && typeof c.reason === "string") msg = c.reason;
    if (!msg && typeof c.shortMessage === "string") msg = c.shortMessage;
    if (!msg && typeof c.message === "string") msg = c.message.split("\n")[0];
  }
  if (raw) {
    try {
      const d = decodeErrorResult({ abi: ERRORS_ABI, data: raw });
      const args = (d.args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
      return { reason: d.errorName === "Error" ? args[0] ?? "Error" : `${d.errorName}(${args.join(",")})`, raw };
    } catch { /* unknown selector */ }
  }
  return { reason: msg ?? "execution reverted (no reason)", raw };
}

/** Decode the top-level call: ERC20 transfer / transferFrom / approve. Never throws. */
export function decodeTokenEffects(tx: { from?: Address; to?: Address; data?: Hex } | null | undefined, unlimitedMin: bigint = SIM_DEFAULTS.unlimitedApproveMin): { effects: TokenEffect[]; warnings: Warning[] } {
  const effects: TokenEffect[] = [];
  const warnings: Warning[] = [];
  if (!tx || typeof tx !== "object") return { effects, warnings };
  const data = tx.data ?? "0x";
  if (data === "0x" || typeof data !== "string") return { effects, warnings };
  const token = tx.to && isAddress(tx.to) ? normalizeAddress(tx.to) : undefined;
  const sender = tx.from && isAddress(tx.from) ? normalizeAddress(tx.from) : undefined;
  if (!token || !sender) return { effects, warnings };
  const abi = [...erc20Abi, { type: "function", name: "transferFrom", stateMutability: "nonpayable",
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] }] as const;
  try {
    const d = decodeFunctionData({ abi, data: data as Hex });
    const src = "calldata (decoded)";
    if (d.functionName === "transfer") {
      const [to, amount] = d.args as [Address, bigint];
      effects.push({ kind: "transfer", token, from: sender, to: normalizeAddress(to) as Address, amount: { value: amount, source: src } });
    } else if (d.functionName === "transferFrom") {
      const [from, to, amount] = d.args as [Address, Address, bigint];
      effects.push({ kind: "transfer", token, from: normalizeAddress(from) as Address, to: normalizeAddress(to) as Address, amount: { value: amount, source: src } });
    } else if (d.functionName === "approve") {
      const [spender, amount] = d.args as [Address, bigint];
      const unlimited = amount >= unlimitedMin;
      effects.push({ kind: "approve", token, owner: sender, spender: normalizeAddress(spender) as Address, amount: { value: amount, source: src }, unlimited });
      if (unlimited) warnings.push({ code: "UNLIMITED_APPROVE", detail: `approve illimitato a ${normalizeAddress(spender)} sul token ${token}` });
    }
  } catch {
    warnings.push({ code: "UNKNOWN_CALLDATA", detail: `calldata non decodificata (selettore ${String(data).slice(0, 10)})` });
  }
  return { effects, warnings };
}

const fmt = (x: bigint) => x.toString();

function parseTx(tx: unknown): { ok: true; value: ProposedTx } | { ok: false; reason: string } {
  if (tx == null || typeof tx !== "object") return { ok: false, reason: "BAD_TX: transazione assente o non valida" };
  const t = tx as Record<string, unknown>;
  const chain = parseCount(t.chainId, "chainId");
  if (!chain.ok) return chain;
  if (chain.value <= 0n) return { ok: false, reason: "BAD_VALUE: chainId deve essere positivo" };
  const from = parseAddr(t.from, "from");
  if (!from.ok) return from;
  const to = parseAddr(t.to, "to");
  if (!to.ok) return to;
  const value = t.value === undefined ? { ok: true as const, value: 0n } : parseCount(t.value, "value");
  if (!value.ok) return value;
  if (value.value < 0n) return { ok: false, reason: "BAD_VALUE: value negativo" };
  const data = t.data === undefined || t.data === "" ? "0x" : t.data;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || data.length % 2 !== 0) {
    return { ok: false, reason: "BAD_VALUE: data non è un hex valido" };
  }
  return { ok: true, value: { chainId: Number(chain.value), from: from.value, to: to.value, data: data as Hex, value: value.value } };
}

/** Simulate a proposed tx against the chain state, without signing. Fail-closed: never throws. */
export async function simulateTx(tx: unknown, client: unknown, o: SimOptions = {}): Promise<SimulationResult> {
  try {
    if (o.now !== undefined && !Number.isFinite(o.now)) return blocked("BAD_NOW: now non è un numero finito");
    if (o.config !== undefined && (o.config == null || typeof o.config !== "object" || Array.isArray(o.config))) {
      return blocked("BadConfig: config non valida");
    }
    const cap = tightenBigint(o.config?.unlimitedApproveMin, SIM_DEFAULTS.unlimitedApproveMin, true);
    if (!cap.ok) return blocked(`BadConfig: ${cap.detail}`);
    const parsed = parseTx(tx);
    if (!parsed.ok) return blocked(parsed.reason);
    const p = parsed.value;
    const c = client as SimClient | null;
    if (!c || typeof c !== "object" || typeof c.call !== "function" || typeof c.estimateGas !== "function") {
      return blocked("BAD_CLIENT: client RPC assente o non valido", { chainId: p.chainId });
    }
    const rpc = o.rpcLabel ?? `rpc chain ${p.chainId}`;
    const value = p.value ?? 0n;
    const args = { account: p.from, to: p.to, data: p.data, value };
    const { effects, warnings } = decodeTokenEffects(p, cap.value);
    const simulatedAt = o.now ?? Date.now();
    const base = { chainId: p.chainId, from: p.from, to: p.to, tokenEffects: effects, warnings, simulatedAt };

    const balance = await c.getBalance({ address: p.from }).then(
      (v) => (typeof v === "bigint" ? { value: v, source: `eth_getBalance @ ${rpc}` } : undefined),
      () => undefined,
    );

    try {
      await c.call(args);
    } catch (e) {
      const revert = revertReason(e);
      return { ...base, ok: false, revert, nativeBalanceBefore: balance,
        nativeDelta: { value: 0n, source: "nessun effetto: la tx fallirebbe" },
        lines: [`❌ Fallirebbe: ${revert.reason}`, ...warnings.map((w) => `⚠️ ${w.detail}`)] };
    }

    let gas: Sourced<bigint> | undefined;
    try {
      const g = await c.estimateGas(args);
      if (typeof g !== "bigint" || g < 0n) return blocked("BAD_VALUE: eth_estimateGas ha restituito un valore non valido", base);
      gas = { value: g, source: `eth_estimateGas @ ${rpc}` };
    } catch (e) {
      const revert = revertReason(e);
      return { ...base, ok: false, revert, nativeBalanceBefore: balance,
        nativeDelta: { value: 0n, source: "nessun effetto: stima del gas fallita" },
        lines: [`❌ Stima gas fallita: ${revert.reason}`] };
    }
    let gasPrice: Sourced<bigint> | undefined;
    if (c.getGasPrice) {
      try {
        const gp = await c.getGasPrice();
        if (typeof gp !== "bigint" || gp < 0n) return blocked("BAD_VALUE: eth_gasPrice ha restituito un valore non valido", base);
        gasPrice = { value: gp, source: `eth_gasPrice @ ${rpc}` };
      } catch { /* optional */ }
    }
    if (!gasPrice) warnings.push({ code: "GAS_PRICE_UNKNOWN", detail: "prezzo del gas non disponibile: costo gas escluso" });

    const fee = gasPrice ? gas.value * gasPrice.value : 0n;
    const nativeDelta = { value: -(value + fee), source: gasPrice ? "calcolo: -(value + gas × gasPrice)" : "calcolo: -(value)" };
    const lines = [
      `✅ Riuscirebbe. Gas stimato: ${fmt(gas.value)} [${gas.source}]`,
      `Saldo nativo: ${fmt(nativeDelta.value)} wei [${nativeDelta.source}]`,
      ...effects.map((e) => e.kind === "transfer"
        ? `Trasferimento token ${e.token}: ${fmt(e.amount.value)} da ${e.from} a ${e.to} [${e.amount.source}]`
        : `Approve token ${e.token}: ${e.unlimited ? "ILLIMITATO" : fmt(e.amount.value)} a ${e.spender} [${e.amount.source}]`),
      ...warnings.map((w) => `⚠️ ${w.detail}`),
    ];
    return { ...base, ok: true, gas, gasPrice, nativeBalanceBefore: balance, nativeDelta, lines };
  } catch (e) {
    return blocked(`CHECK_ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------- adapters to teammates' formats ----------------

/** bytes32 label, UTF-8 left-aligned (same encoding PlanExecutor uses for ActionBlocked.reason). */
export const reasonLabel = (s: string): Hex => stringToHex(s.slice(0, 31), { size: 32 });

/**
 * Shared QueueEvent (Primo) for a blocked simulation.
 * kind "blocked", planId lowercase, amount as known bigint (never rewritten to 0n).
 * Codes: SimRevert | SimUnavailable | UnlimitedApprove.
 */
export function toActionBlocked(sim: unknown, planId: Hex, o: { ts?: number; nativeValue?: bigint } = {}): QueueEvent | null {
  let id: Hex;
  try { id = normalizePlanId(planId); }
  catch { return blockedEvent({ planId: "0x" + "00".repeat(32), reason: "SimUnavailable", amount: 0n, ts: o.ts, id: null }); }

  const knownAmount = (s: SimulationResult | undefined): bigint => {
    let amount = 0n;
    const effects = s && Array.isArray(s.tokenEffects) ? s.tokenEffects : [];
    for (const e of effects) {
      const v = e?.amount?.value;
      if (typeof v === "bigint" && v > amount) amount = v;
    }
    if (amount === 0n && typeof o.nativeValue === "bigint" && o.nativeValue > 0n) return o.nativeValue;
    return amount;
  };

  if (!sim || typeof sim !== "object") {
    return blockedEvent({ planId: id, reason: "SimUnavailable", amount: knownAmount(undefined), ts: o.ts });
  }
  const s = sim as SimulationResult;
  const amount = knownAmount(s);
  if (!simSucceeded(s)) {
    const reasonText = s.revert?.reason ?? "";
    const unavailable = reasonText.startsWith("BAD_") || reasonText.startsWith("CHECK_ERROR") || reasonText.startsWith("BadConfig");
    return blockedEvent({
      planId: id,
      reason: reasonText.startsWith("BadConfig") ? "BadConfig" : unavailable ? "SimUnavailable" : "SimRevert",
      amount,
      ts: o.ts ?? s.simulatedAt,
    });
  }
  if ((s.warnings ?? []).some((w) => w.code === "UNLIMITED_APPROVE")) {
    return blockedEvent({ planId: id, reason: "UnlimitedApprove", amount, ts: o.ts ?? s.simulatedAt });
  }
  return null;
}

/** Hunter's success-odds: one dry-run entry plus gasNeeded for `state`. `ok` is only true if sim.ok === true. */
export const toSuccessOddsInput = (sim: unknown) => {
  const s = sim && typeof sim === "object" ? (sim as SimulationResult) : undefined;
  const ok = simSucceeded(s);
  return {
    dryRun: [{ ok, reason: ok ? undefined : `simulazione: ${s?.revert?.reason ?? "ok non è true"}` }],
    gasNeeded: ok && s?.gas && s.gasPrice && typeof s.gas.value === "bigint" && typeof s.gasPrice.value === "bigint"
      ? s.gas.value * s.gasPrice.value : undefined,
  };
};

/** Hunter's SAFE HOLD: a failed or invalid simulation becomes a low-confidence observation => HOLD. Intent is redacted. */
export const toSafeHoldInput = (sim: unknown, intent?: unknown) => {
  const s = sim && typeof sim === "object" ? (sim as SimulationResult) : undefined;
  const ok = simSucceeded(s);
  const key = `sim:${s?.chainId ?? "unknown"}`;
  const at = Number.isFinite(s?.simulatedAt) ? s!.simulatedAt : Date.now();
  return {
    intent: intent === undefined ? undefined : redactSecrets(intent),
    now: at,
    required: [key],
    observations: [{ key, value: ok ? 1 : 0, observedAt: at, source: "eth_call", confidence: ok ? 1 : 0 }],
  };
};
