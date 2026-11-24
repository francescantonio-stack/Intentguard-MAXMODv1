import { decodeFunctionData, getAddress, maxUint256, sha256, stringToHex, toHex, type Hex } from "viem";
import { cctpAbi, erc20Abi, planExecutorAbi } from "./abi";
import { BASE_SEPOLIA, MONAD_TESTNET } from "./chains";
import type { Step } from "./planner";

/**
 * Explicit, fresh consent (Orvena idea) + plain-language explanation (PlainSign idea).
 *
 * The approver sees (1) a plain Italian sentence, generated deterministically (no LLM), ABOVE
 * (2) the EXACT text of the transaction, and (3) the SHA-256 of the canonical payload.
 * A consent is bound to that hash, has a nonce and a short expiry, and is single-use.
 * This is a UI/logic check only: no wallet, no key, no signature. Verification is hashing.
 */

// ---------- payload ----------

export type NearAction =
  | { type: "Transfer"; deposit: bigint }
  | { type: "FunctionCall"; method: string; args: Record<string, unknown>; deposit: bigint; gas: bigint }
  | { type: "AddKey"; publicKey: string; permission: "FullAccess" | { receiverId: string; methodNames: string[] } }
  | { type: "DeleteKey"; publicKey: string };

export type TxPayload =
  | { kind: "near"; network: "mainnet" | "testnet"; signer: string; receiver: string; actions: NearAction[] }
  | { kind: "evm"; network: string; chainId: number; to: Hex; value: bigint; data?: Hex; gas?: bigint };

const NEAR_DECIMALS = 24;
const NEAR_FT_DECIMALS: Record<string, { symbol: string; decimals: number }> = {
  "usdt.tether-token.near": { symbol: "USDT", decimals: 6 },
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", decimals: 6 },
  "wrap.near": { symbol: "wNEAR", decimals: 24 },
};
const evmTokens = (): Record<string, { symbol: string; decimals: number }> => ({
  [getAddress(MONAD_TESTNET.usdc)]: { symbol: "USDC", decimals: 6 },
  [getAddress(BASE_SEPOLIA.usdc)]: { symbol: "USDC", decimals: 6 },
  [getAddress(MONAD_TESTNET.wmon)]: { symbol: "WMON", decimals: 18 },
});
const evmNative = (chainId: number) => (chainId === MONAD_TESTNET.id ? "MON" : "ETH");

/** Base units -> decimal string with Italian comma ("1500000", 6 -> "1,5"). Never via floats. */
export function formatUnitsIt(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = (u % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const s = frac ? `${u / base},${frac}` : (u / base).toString();
  return neg ? `-${s}` : s;
}

/** Canonical JSON: sorted keys, bigint as decimal string. Same input -> same bytes. */
export function canonicalJson(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

// ---------- decoding ----------

type Decoded = { method: string; args: Record<string, unknown> } | null;

function decodeEvm(data?: Hex): Decoded {
  if (!data || data === "0x") return null;
  for (const abi of [erc20Abi, cctpAbi, planExecutorAbi]) {
    try {
      const d = decodeFunctionData({ abi, data });
      const item = abi.find((x) => x.type === "function" && x.name === d.functionName) as { inputs: { name?: string }[] } | undefined;
      const args: Record<string, unknown> = {};
      (d.args ?? []).forEach((a, i) => (args[item?.inputs[i]?.name || `arg${i}`] = a));
      return { method: d.functionName, args };
    } catch { /* try next */ }
  }
  return null;
}

const near = (y: bigint) => `${formatUnitsIt(y, NEAR_DECIMALS)} NEAR`;
const tgas = (g: bigint) => `${formatUnitsIt(g, 12)} TGas`;
const ftAmount = (token: string, raw: unknown) => {
  const t = NEAR_FT_DECIMALS[token];
  const s = String(raw ?? "?");
  return t && /^\d+$/.test(s) ? `${formatUnitsIt(BigInt(s), t.decimals)} ${t.symbol}` : `${s} unità di ${token}`;
};

// ---------- exact text ----------

/** The EXACT, complete text of the transaction. Every field, nothing summarised away. */
export function exactText(p: TxPayload): string[] {
  if (p.kind === "near") {
    const lines = [`Rete: NEAR ${p.network}`, `Firmatario: ${p.signer}`, `Destinatario: ${p.receiver}`, `Azioni: ${p.actions.length}`];
    p.actions.forEach((a, i) => {
      const n = `#${i + 1}`;
      if (a.type === "Transfer") lines.push(`${n} Transfer · deposito: ${near(a.deposit)} (${a.deposit} yocto)`);
      else if (a.type === "FunctionCall")
        lines.push(`${n} FunctionCall · metodo: ${a.method} · argomenti: ${canonicalJson(a.args)} · deposito: ${near(a.deposit)} (${a.deposit} yocto) · gas: ${tgas(a.gas)} (${a.gas})`);
      else if (a.type === "AddKey")
        lines.push(`${n} AddKey · chiave pubblica: ${a.publicKey} · permesso: ${a.permission === "FullAccess" ? "FullAccess" : `FunctionCall su ${a.permission.receiverId} [${a.permission.methodNames.join(", ") || "tutti i metodi"}]`}`);
      else if (a.type === "DeleteKey") lines.push(`${n} DeleteKey · chiave pubblica: ${a.publicKey}`);
      else lines.push(`${n} ${canonicalJson(a)}`);
    });
    return lines;
  }
  const d = decodeEvm(p.data);
  const tok = evmTokens()[getAddress(p.to)];
  const lines = [`Rete: ${p.network} (chainId ${p.chainId})`, `Destinatario (contratto): ${p.to}`, `Valore nativo: ${formatUnitsIt(p.value, 18)} ${evmNative(p.chainId)} (${p.value} wei)`];
  if (d) {
    lines.push(`Metodo: ${d.method}`);
    for (const [k, v] of Object.entries(d.args)) {
      const amt = typeof v === "bigint" && tok && /amount|value/i.test(k) ? ` = ${v === maxUint256 ? "ILLIMITATO" : `${formatUnitsIt(v, tok.decimals)} ${tok.symbol}`}` : "";
      lines.push(`  ${k}: ${canonicalJson(v).replace(/^"|"$/g, "")}${amt}`);
    }
  } else if (p.data && p.data !== "0x") lines.push(`Metodo: non decodificato`);
  lines.push(`Dati grezzi: ${p.data ?? "0x"}`);
  lines.push(`Gas: ${p.gas !== undefined ? p.gas.toString() : "stimato al momento dell'invio"}`);
  return lines;
}

// ---------- plain sentence (PlainSign) ----------

export type Risk = "normal" | "high" | "unknown";
export type PlainExplanation = { text: string; risk: Risk };

const UNKNOWN = "Azione non riconosciuta: controlla il testo esatto.";

/** Deterministic plain-Italian explanation. Always shown ABOVE exactText, never instead of it. */
export function plainExplanation(p: TxPayload): PlainExplanation[] {
  if (p.kind === "near") {
    if (p.actions.length === 0) return [{ text: UNKNOWN, risk: "unknown" }];
    return p.actions.map((a): PlainExplanation => {
      switch (a.type) {
        case "Transfer":
          return { text: `Stai inviando ${near(a.deposit)} a ${p.receiver} su ${p.network}.`, risk: "normal" };
        case "FunctionCall": {
          const args = a.args as Record<string, unknown>;
          if (a.method === "ft_transfer" || a.method === "ft_transfer_call")
            return { text: `Stai inviando ${ftAmount(p.receiver, args.amount)} a ${String(args.receiver_id ?? "?")} tramite il metodo ${a.method} su ${p.network}.`, risk: "normal" };
          if (a.method === "nft_transfer" || a.method === "nft_transfer_call")
            return { text: `Stai trasferendo l'NFT "${String(args.token_id ?? "?")}" della collezione ${p.receiver} a ${String(args.receiver_id ?? "?")} su ${p.network}.`, risk: "normal" };
          if (a.method === "storage_deposit")
            return { text: `Stai pagando ${near(a.deposit)} di deposito di storage su ${p.receiver} per ${String(args.account_id ?? p.signer)} su ${p.network}.`, risk: "normal" };
          return { text: `Stai chiamando il metodo ${a.method} del contratto ${p.receiver} su ${p.network}${a.deposit > 0n ? `, allegando ${near(a.deposit)}` : ""}.`, risk: a.deposit > 0n ? "high" : "normal" };
        }
        case "AddKey":
          return a.permission === "FullAccess"
            ? { text: `RISCHIO ALTO: stai aggiungendo una chiave con ACCESSO COMPLETO al conto ${p.signer} su ${p.network}. Chi la possiede può spostare tutti i fondi.`, risk: "high" }
            : { text: `RISCHIO ALTO: stai aggiungendo una chiave al conto ${p.signer} su ${p.network}, limitata al contratto ${a.permission.receiverId}.`, risk: "high" };
        case "DeleteKey":
          return { text: `RISCHIO ALTO: stai eliminando la chiave ${a.publicKey} dal conto ${p.signer} su ${p.network}. Potresti perdere l'accesso.`, risk: "high" };
        default:
          return { text: UNKNOWN, risk: "unknown" };
      }
    });
  }
  const d = decodeEvm(p.data);
  const tok = evmTokens()[getAddress(p.to)];
  const native = evmNative(p.chainId);
  if (!p.data || p.data === "0x")
    return [{ text: `Stai inviando ${formatUnitsIt(p.value, 18)} ${native} a ${p.to} su ${p.network}.`, risk: "normal" }];
  if (!d) return [{ text: UNKNOWN, risk: "unknown" }];
  const extra = p.value > 0n ? `, allegando ${formatUnitsIt(p.value, 18)} ${native}` : "";
  const amt = (v: unknown) => (tok && typeof v === "bigint" ? `${formatUnitsIt(v, tok.decimals)} ${tok.symbol}` : `${String(v)} unità del token ${p.to}`);
  if (d.method === "transfer")
    return [{ text: `Stai inviando ${amt(d.args.amount)} a ${String(d.args.to)} tramite il metodo transfer su ${p.network}${extra}.`, risk: "normal" }];
  if (d.method === "approve") {
    if (d.args.amount === maxUint256)
      return [{ text: `RISCHIO ALTO: stai autorizzando ${String(d.args.spender)} a spendere una quantità ILLIMITATA di ${tok?.symbol ?? "token"} su ${p.network}.`, risk: "high" }];
    return [{ text: `Stai autorizzando ${String(d.args.spender)} a spendere fino a ${amt(d.args.amount)} su ${p.network}${extra}.`, risk: "normal" }];
  }
  if (d.method === "depositForBurn")
    return [{ text: `Stai spostando ${formatUnitsIt(d.args.amount as bigint, 6)} USDC da ${p.network} a un'altra rete con CCTP (commissione massima ${formatUnitsIt(d.args.maxFee as bigint, 6)} USDC).`, risk: "normal" }];
  if (d.method === "registerPasskey")
    return [{ text: `RISCHIO ALTO: stai registrando una nuova passkey con tetto settimanale ${formatUnitsIt(d.args.weeklyCap as bigint, 6)} USDC su ${p.network}.`, risk: "high" }];
  return [{ text: `Stai chiamando il metodo ${d.method} del contratto ${p.to} su ${p.network}${extra}.`, risk: "normal" }];
}

/** IntentGuard plan step -> payload, so the PWA shows the real calldata of each step. */
export function payloadFromStep(s: Step): TxPayload {
  return { kind: "evm", network: s.chain, chainId: s.chainId, to: s.to, value: s.value ?? 0n, ...(s.data && { data: s.data }) };
}

// ---------- the approval view ----------

export type ApprovalView = { plain: PlainExplanation[]; exact: string[]; payloadHash: Hex };

/**
 * What the approver sees. The hash covers payload + exact text + plain sentence, so a change to
 * any of them (or to how they are rendered) invalidates an existing consent.
 */
export function approvalView(p: TxPayload): ApprovalView {
  const plain = plainExplanation(p);
  const exact = exactText(p);
  const payloadHash = sha256(stringToHex(canonicalJson({ v: 1, payload: p, exact, plain })));
  return { plain, exact, payloadHash };
}

/** Plain text render (CLI / MCP / logs): plain sentence first, then exact text, then hash. */
export function renderApproval(v: ApprovalView): string {
  return [
    "In parole semplici:",
    ...v.plain.map((x) => `${x.risk === "high" ? "⚠ " : x.risk === "unknown" ? "? " : ""}${x.text}`),
    "",
    "Testo esatto:",
    ...v.exact,
    "",
    `Hash del payload (SHA-256): ${v.payloadHash}`,
  ].join("\n");
}

// ---------- shared event (Primo) ----------

/** Shared log event for every IntentGuard guard module. amount is base units, never a string. */
export type GuardEvent = {
  kind: string;
  planId: `0x${string}`;
  reason: string;
  amount: bigint;
  ts: string;
  id: string | null;
};

export const lowerPlanId = (id: string): `0x${string}` =>
  (id.startsWith("0x") ? id : `0x${id}`).toLowerCase() as `0x${string}`;

export function guardEvent(o: {
  kind: string;
  planId: string;
  reason: string;
  amount: bigint;
  now: number;
  id?: string | null;
}): GuardEvent {
  const ts = Number.isFinite(o.now) ? new Date(o.now).toISOString() : new Date().toISOString();
  return {
    kind: o.kind,
    planId: lowerPlanId(o.planId),
    reason: o.reason,
    amount: o.amount,
    ts,
    id: o.id ?? null,
  };
}

// ---------- fresh consent ----------

export const CONSENT_TTL_MS = 120_000;
export const CONSENT_WINDOW_MS = 86_400_000;
const ZERO_HASH = ("0x" + "00".repeat(32)) as `0x${string}`;

/** Finite number from a number or a bigint only. A string like "0.1" is rejected (fail-closed). */
export function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
    return Number(v);
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

/** Amounts and counters: number or bigint (0n behaves like 0). Strings are rejected. */
export function asAmount(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return BigInt(v);
  return undefined;
}

/** Nonces may arrive as string or number ("3" vs 3); both are the same nonce. */
export function normNonce(v: unknown): string | undefined {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) return String(v);
  if (typeof v === "string" && v !== "") return v.toLowerCase();
  return undefined;
}

/** Success only when `ok === true`. `{ok: 0}` and other truthy values do not pass. */
export function consentPassed(r: unknown): boolean {
  return typeof r === "object" && r !== null && (r as { ok?: unknown }).ok === true;
}

export type Consent = { payloadHash: `0x${string}`; nonce: string; issuedAt: number; expiresAt: number };

export type ConsentReason =
  | "ConsentExpired"
  | "ConsentPayloadMismatch"
  | "ConsentReplay"
  | "ConsentRejected"
  | "ConsentMalformed"
  | "ConsentBadNow"
  | "Expired"
  | "Consumed"
  | "NotConsented";

export type ConsentBlocked = GuardEvent;

export const toJsonLine = (r: GuardEvent) =>
  JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Main amount moved by the payload, in base units. Accepts bigint and number; never throws. */
export function payloadAmount(p: unknown): bigint {
  try {
    if (!p || typeof p !== "object") return 0n;
    const tx = p as TxPayload;
    if (tx.kind === "near") {
      return (tx.actions ?? []).reduce((s, a) => s + (asAmount((a as { deposit?: unknown }).deposit) ?? 0n), 0n);
    }
    if (tx.kind === "evm") {
      const d = decodeEvm(tx.data);
      return asAmount(d?.args.amount) ?? asAmount(tx.value) ?? 0n;
    }
    return 0n;
  } catch {
    return 0n;
  }
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

function isPayload(p: unknown): p is TxPayload {
  if (!p || typeof p !== "object") return false;
  const k = (p as TxPayload).kind;
  return k === "near" || k === "evm";
}

function planIdOf(p: unknown, fallback: `0x${string}` = ZERO_HASH): `0x${string}` {
  try {
    if (isPayload(p)) return lowerPlanId(approvalView(p).payloadHash);
  } catch { /* fall through */ }
  return fallback;
}

type Stored = {
  nonce: string;
  planId: `0x${string}`;
  payloadHash: `0x${string}`;
  status: "issued" | "consented" | "consumed" | "expired" | "rejected";
  issuedAt: number;
  expiresAt: number;
  amount: bigint;
  decidedAt?: number;
};

/** Issued when the approval view is shown. Bound to exactly that payload hash. */
export function issueConsent(
  view: ApprovalView,
  o: { now?: number | bigint; ttlMs?: number | bigint; nonce?: string | number; log?: (e: GuardEvent) => void; amount?: bigint } = {},
): Consent {
  const issuedAt = asFiniteNumber(o.now) ?? Date.now();
  const ttl = asFiniteNumber(o.ttlMs) ?? CONSENT_TTL_MS;
  const consent: Consent = {
    payloadHash: lowerPlanId(view.payloadHash),
    nonce: normNonce(o.nonce) ?? randomNonce(),
    issuedAt,
    expiresAt: issuedAt + ttl,
  };
  o.log?.(
    guardEvent({
      kind: "consent_shown",
      planId: consent.payloadHash,
      reason: "",
      amount: o.amount ?? 0n,
      now: issuedAt,
      id: consent.nonce,
    }),
  );
  return consent;
}

/**
 * Remembers consents. Expired, rejected and consumed records older than the window are pruned,
 * but seen planIds stay so a replay is still blocked.
 */
export class ConsentStore {
  private recs = new Map<string, Stored>();
  private seenPlanIds = new Set<string>();
  private seq = 0;
  has = (nonce: unknown) => {
    const n = normNonce(nonce);
    return n !== undefined && this.recs.has(n);
  };
  get = (nonce: unknown) => {
    const n = normNonce(nonce);
    return n !== undefined ? this.recs.get(n) : undefined;
  };
  put = (row: Stored) => {
    this.recs.set(row.nonce, row);
    this.seenPlanIds.add(row.planId);
  };
  /** Marks a nonce as already used (replay). Accepts string or number forms. */
  spend = (nonce: unknown) => {
    const n = normNonce(nonce);
    if (n === undefined) return;
    const prev = this.recs.get(n);
    this.put({
      nonce: n,
      planId: prev?.planId ?? ZERO_HASH,
      payloadHash: prev?.payloadHash ?? ZERO_HASH,
      status: "consumed",
      issuedAt: prev?.issuedAt ?? 0,
      expiresAt: prev?.expiresAt ?? 0,
      amount: prev?.amount ?? 0n,
      decidedAt: Date.now(),
    });
  };
  seen = (planId: string) => this.seenPlanIds.has(lowerPlanId(planId));
  /** True if this planId was already consented or consumed (replay). */
  wasUsed = (planId: string) => {
    const id = lowerPlanId(planId);
    if (!this.seenPlanIds.has(id)) return false;
    for (const r of this.recs.values()) {
      if (r.planId === id && (r.status === "consented" || r.status === "consumed" || r.status === "rejected" || r.status === "expired")) return true;
    }
    // pruned but still seen
    return this.seenPlanIds.has(id);
  };
  prune = (now: number, windowMs = CONSENT_WINDOW_MS) => {
    const cut = now - windowMs;
    for (const [k, r] of this.recs) {
      if ((r.status === "expired" || r.status === "rejected" || r.status === "consumed") && (r.decidedAt ?? r.expiresAt) < cut) {
        this.recs.delete(k);
      }
    }
  };
  get size() { return this.recs.size; }
  get seenCount() { return this.seenPlanIds.size; }
}

export type VerifyResult = { ok: true; event: GuardEvent } | { ok: false; reason: ConsentReason; record: GuardEvent };

export class ConsentError extends Error {
  constructor(public readonly code: ConsentReason, message: string, public readonly event: GuardEvent) {
    super(message);
    this.name = "ConsentError";
  }
}

/**
 * Valid only if: same payload hash as what is about to run, not expired, never used.
 * Success marks the consent as `consented` (it still expires). Fail-closed: never crash, never pass on bad input.
 */
export function verifyConsent(
  consent: unknown,
  current: unknown,
  o?: { store?: ConsentStore; now?: unknown; log?: (r: GuardEvent) => void; amount?: bigint },
): VerifyResult {
  const log = o && typeof o === "object" ? o.log : undefined;
  const store = o && typeof o === "object" ? o.store : undefined;
  const nowRaw = o && typeof o === "object" && "now" in o && o.now !== undefined ? o.now : Date.now();
  const now = asFiniteNumber(nowRaw);
  const knownAmount = o && typeof o === "object" ? asAmount(o.amount) : undefined;

  const fail = (kind: string, reason: ConsentReason, planId: `0x${string}`, amount: bigint, nonce?: string, at?: number): VerifyResult => {
    const record = guardEvent({ kind, planId, reason, amount, now: at ?? (now ?? Date.now()), id: nonce ?? null });
    log?.(record);
    return { ok: false, reason, record };
  };

  try {
    const amountHint = (p: unknown) => knownAmount ?? payloadAmount(p);
    if (now === undefined) {
      return fail("blocked", "ConsentBadNow", planIdOf(current), amountHint(current));
    }
    if (!isPayload(current)) return fail("blocked", "ConsentMalformed", ZERO_HASH, knownAmount ?? 0n);
    const view = approvalView(current);
    const planId = lowerPlanId(view.payloadHash);
    const amount = amountHint(current);
    const c = consent as Consent | null | undefined;
    if (!c || typeof c !== "object") return fail("blocked", "ConsentMalformed", planId, amount);
    const nonce = normNonce(c.nonce);
    const hash = typeof c.payloadHash === "string" && /^0x[0-9a-f]{64}$/i.test(c.payloadHash) ? lowerPlanId(c.payloadHash) : undefined;
    const issuedAt = asFiniteNumber(c.issuedAt);
    const expiresAt = asFiniteNumber(c.expiresAt);
    if (!hash || nonce === undefined || issuedAt === undefined || expiresAt === undefined) {
      return fail("blocked", "ConsentMalformed", planId, amount, nonce);
    }
    if (!store) return fail("blocked", "ConsentMalformed", planId, amount, nonce);
    store.prune(now);
    const existing = store.get(nonce);
    if (existing && (existing.status === "consented" || existing.status === "consumed" || existing.status === "rejected")) {
      return fail("blocked", "ConsentReplay", planId, amount, nonce);
    }
    if (store.wasUsed(planId) && existing?.status !== "issued") {
      return fail("blocked", "ConsentReplay", planId, amount, nonce);
    }
    if (now > expiresAt || now < issuedAt) {
      if (existing) store.put({ ...existing, status: "expired", decidedAt: now });
      return fail("expired", "ConsentExpired", planId, amount, nonce);
    }
    if (hash !== planId) return fail("blocked", "ConsentPayloadMismatch", planId, amount, nonce);
    store.put({ nonce, planId, payloadHash: hash, status: "consented", issuedAt, expiresAt, amount, decidedAt: now });
    const event = guardEvent({ kind: "consented", planId, reason: "Consented", amount, now, id: nonce });
    log?.(event);
    return { ok: true, event };
  } catch {
    return fail("blocked", "ConsentMalformed", ZERO_HASH, knownAmount ?? 0n);
  }
}

/**
 * Spends a previously consented token. A consented (not only pending) token expires:
 * if `now > expiresAt`, this throws and emits `expired`.
 */
export function consumeConsent(
  consent: unknown,
  current: unknown,
  o?: { store?: ConsentStore; now?: unknown; log?: (r: GuardEvent) => void; amount?: bigint },
): GuardEvent {
  const log = o?.log;
  const store = o?.store;
  const now = asFiniteNumber(o && "now" in (o ?? {}) && o?.now !== undefined ? o.now : Date.now());
  const knownAmount = asAmount(o?.amount);
  const emitThrow = (kind: string, reason: ConsentReason, planId: `0x${string}`, amount: bigint, nonce?: string): never => {
    const event = guardEvent({ kind, planId, reason, amount, now: now ?? Date.now(), id: nonce ?? null });
    log?.(event);
    throw new ConsentError(reason, reason, event);
  };
  if (now === undefined) return emitThrow("blocked", "ConsentBadNow", planIdOf(current), knownAmount ?? payloadAmount(current));
  if (!store) return emitThrow("blocked", "ConsentMalformed", planIdOf(current), knownAmount ?? payloadAmount(current));
  store.prune(now);
  const c = consent as Consent | null | undefined;
  const nonce = c && typeof c === "object" ? normNonce(c.nonce) : undefined;
  const row = nonce !== undefined ? store.get(nonce) : undefined;
  const planId = row?.planId ?? planIdOf(current);
  const amount = knownAmount ?? row?.amount ?? payloadAmount(current);
  if (!row || nonce === undefined) return emitThrow("blocked", "NotConsented", planId, amount, nonce);
  if (row.status === "consumed") return emitThrow("blocked", "ConsentReplay", planId, amount, nonce);
  if (row.status === "rejected") return emitThrow("blocked", "ConsentRejected", planId, amount, nonce);
  if (row.status === "expired" || now > row.expiresAt) {
    store.put({ ...row, status: "expired", decidedAt: now });
    return emitThrow("expired", "Expired", planId, amount, nonce);
  }
  if (row.status !== "consented") return emitThrow("blocked", "NotConsented", planId, amount, nonce);
  if (isPayload(current) && lowerPlanId(approvalView(current).payloadHash) !== row.planId) {
    return emitThrow("blocked", "ConsentPayloadMismatch", planId, amount, nonce);
  }
  store.put({ ...row, status: "consumed", decidedAt: now, amount });
  const event = guardEvent({ kind: "consumed", planId, reason: "Consumed", amount, now, id: nonce });
  log?.(event);
  return event;
}

/** The approver pressed "Rifiuta": log it and burn the nonce so it can never be used. Never throws. */
export function rejectConsent(
  consent: unknown,
  current: unknown,
  o?: { store?: ConsentStore; now?: unknown; log?: (r: GuardEvent) => void; amount?: bigint },
): GuardEvent {
  try {
    const c = consent as Consent | null | undefined;
    const nonce = c && typeof c === "object" ? normNonce(c.nonce) : undefined;
    const now = asFiniteNumber(o?.now) ?? Date.now();
    const planId = planIdOf(current);
    const amount = asAmount(o?.amount) ?? payloadAmount(current);
    if (nonce !== undefined && o?.store) {
      const prev = o.store.get(nonce);
      o.store.put({
        nonce,
        planId: prev?.planId ?? planId,
        payloadHash: prev?.payloadHash ?? planId,
        status: "rejected",
        issuedAt: prev?.issuedAt ?? now,
        expiresAt: prev?.expiresAt ?? now,
        amount,
        decidedAt: now,
      });
    }
    const r = guardEvent({ kind: "rejected", planId, reason: "ConsentRejected", amount, now, id: nonce ?? null });
    o?.log?.(r);
    return r;
  } catch {
    const r = guardEvent({ kind: "rejected", planId: ZERO_HASH, reason: "ConsentRejected", amount: asAmount(o?.amount) ?? 0n, now: Date.now(), id: null });
    o?.log?.(r);
    return r;
  }
}

// ---------- log redaction (logs only; PlainSign / exact text are never redacted) ----------

const SECRET_KEY = /^(authorization|bearer|jwt|auth|recovery_phrase|password|passphrase|seed|private_?key|secret|mnemonic|sig|sk|pk)$/i;

function looksLikeSecretValue(s: string): boolean {
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s)) return true;
  if (/^Bearer\s+\S+/i.test(s.trim())) return true;
  const words = s.trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

/** Redact secrets in a log payload. Does not touch approval text. Word-boundary keys only (tokenIn stays visible). */
export function redactSecrets(v: unknown): unknown {
  if (typeof v === "string") return looksLikeSecretValue(v) ? "[redacted]" : v;
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) || (typeof val === "string" && looksLikeSecretValue(val)) ? "[redacted]" : redactSecrets(val);
  }
  return out;
}
