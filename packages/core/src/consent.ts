import { decodeFunctionData, getAddress, maxUint256, parseAbi, sha256, stringToHex, toHex, type Hex } from "viem";
import { cctpAbi, erc20Abi, planExecutorAbi } from "./abi";
import { BASE_SEPOLIA, MONAD_TESTNET } from "./chains";
import type { Step } from "./planner";
import type { QueueEvent } from "./events";

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

// ---------- decoding (isolated: swap this block for import from ./approvals when QC pushes it) ----------

/** Valid calldata: 0x plus an even number of hex digits (including empty "0x"). */
export const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

export function isValidHexData(data: unknown): data is Hex {
  return typeof data === "string" && HEX_DATA_RE.test(data);
}

/** increaseAllowance / EIP-2612 permit / DAI permit / setApprovalForAll — not in the repo's erc20Abi. */
const increaseAllowanceAbi = parseAbi([
  "function increaseAllowance(address spender,uint256 addedValue) returns (bool)",
]);
const eip2612PermitAbi = parseAbi([
  "function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
]);
const daiPermitAbi = parseAbi([
  "function permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed,uint8 v,bytes32 r,bytes32 s)",
]);
const setApprovalForAllAbi = parseAbi([
  "function setApprovalForAll(address operator,bool approved)",
]);

const EVM_ABIS = [erc20Abi, increaseAllowanceAbi, eip2612PermitAbi, daiPermitAbi, setApprovalForAllAbi, cctpAbi, planExecutorAbi];

/** 4-byte selectors of approve / increaseAllowance / permit / setApprovalForAll. */
export const SENSITIVE_SELECTORS: Record<string, "approve" | "increaseAllowance" | "permit" | "setApprovalForAll"> = {
  "0x095ea7b3": "approve",
  "0x39509351": "increaseAllowance",
  "0xd505accf": "permit",
  "0x8fcbaf0c": "permit",
  "0xa22cb465": "setApprovalForAll",
};

export function evmSelector(data: string): string | undefined {
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) return data.slice(0, 10).toLowerCase();
  return undefined;
}

type Decoded = { method: string; args: Record<string, unknown>; style?: "dai-permit" | "eip2612-permit" } | null;

function decodeEvm(data?: Hex): Decoded {
  if (!data || data === "0x") return null;
  if (!isValidHexData(data)) return null;
  for (const abi of EVM_ABIS) {
    try {
      const d = decodeFunctionData({ abi, data });
      const item = abi.find((x) => x.type === "function" && x.name === d.functionName) as { inputs: { name?: string }[] } | undefined;
      const args: Record<string, unknown> = {};
      (d.args ?? []).forEach((a, i) => (args[item?.inputs[i]?.name || `arg${i}`] = a));
      const style = abi === daiPermitAbi ? "dai-permit" as const : abi === eip2612PermitAbi ? "eip2612-permit" as const : undefined;
      return { method: d.functionName, args, ...(style && { style }) };
    } catch { /* try next */ }
  }
  return null;
}

/**
 * True when calldata starts with an approve / increaseAllowance / permit / setApprovalForAll
 * selector but cannot be fully decoded (truncated, invalid hex after the selector, or wrong ABI shape).
 * A truly unknown selector is not a malformed approval.
 */
export function isMalformedApproval(data: unknown): { method: string } | undefined {
  if (typeof data !== "string") return undefined;
  const sel = evmSelector(data);
  const method = sel ? SENSITIVE_SELECTORS[sel] : undefined;
  if (!method) return undefined;
  if (!isValidHexData(data) || data === "0x") return { method };
  if (decodeEvm(data as Hex)) return undefined;
  return { method };
}

export function evmPayloadIssue(p: unknown): "MALFORMED: data" | "MALFORMED: value" | "MalformedApproval" | undefined {
  if (!p || typeof p !== "object") return undefined;
  const tx = p as TxPayload;
  if (tx.kind !== "evm") return undefined;
  if (asAmount((tx as { value?: unknown }).value) === undefined) return "MALFORMED: value";
  const data = (tx as { data?: unknown }).data;
  if (isMalformedApproval(data)) return "MalformedApproval";
  if (data !== undefined && data !== null && data !== "") {
    if (!isValidHexData(data)) return "MALFORMED: data";
  }
  return undefined;
}

const MALFORMED_APPROVAL_TEXT = "Autorizzazione incompleta o malformata (approve, permit o setApprovalForAll): il piano è bloccato.";
const BAD_DATA_WARNING = "ATTENZIONE: i dati della transazione non sono hex 0x valido. Non fidarti: controlla il testo esatto.";
const BAD_VALUE_WARNING = "ATTENZIONE: il valore nativo della transazione non è un numero valido. Non fidarti: controlla il testo esatto.";

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
  const issue = evmPayloadIssue(p);
  let tok: { symbol: string; decimals: number } | undefined;
  try { tok = evmTokens()[getAddress(p.to)]; } catch { /* invalid to: leave tok unset */ }
  const valueOk = asAmount((p as { value?: unknown }).value);
  const nativeAmt = valueOk !== undefined
    ? `${formatUnitsIt(valueOk, 18)} ${evmNative(p.chainId)} (${valueOk} wei)`
    : "non valido";
  const lines = [`Rete: ${p.network} (chainId ${p.chainId})`, `Destinatario (contratto): ${p.to}`, `Valore nativo: ${nativeAmt}`];
  if (issue === "MALFORMED: data") {
    lines.push("Metodo: non decodificato (dati non sono hex 0x valido)");
    lines.push(`Dati grezzi: ${String((p as { data?: unknown }).data)}`);
  } else if (issue === "MALFORMED: value") {
    const d = isValidHexData(p.data) || p.data === undefined ? decodeEvm(p.data) : null;
    if (d) {
      lines.push(`Metodo: ${d.method}`);
      for (const [k, v] of Object.entries(d.args)) lines.push(`  ${k}: ${canonicalJson(v).replace(/^"|"$/g, "")}`);
    } else if (p.data && p.data !== "0x") lines.push("Metodo: non decodificato");
    lines.push(`Dati grezzi: ${p.data ?? "0x"}`);
  } else {
    const d = decodeEvm(p.data);
    const trunc = isMalformedApproval(p.data);
    if (d) {
      lines.push(`Metodo: ${d.method}`);
      for (const [k, v] of Object.entries(d.args)) {
        const amt = typeof v === "bigint" && tok && /amount|value|addedValue/i.test(k) ? ` = ${v === maxUint256 ? "ILLIMITATO" : `${formatUnitsIt(v, tok.decimals)} ${tok.symbol}`}` : "";
        lines.push(`  ${k}: ${canonicalJson(v).replace(/^"|"$/g, "")}${amt}`);
      }
    } else if (trunc) {
      lines.push(`Metodo: ${trunc.method} (incompleto o malformato)`);
      lines.push(MALFORMED_APPROVAL_TEXT);
    } else if (p.data && p.data !== "0x") lines.push("Metodo: non decodificato");
    lines.push(`Dati grezzi: ${p.data ?? "0x"}`);
  }
  const gas = (p as { gas?: unknown }).gas;
  lines.push(`Gas: ${typeof gas === "bigint" || (typeof gas === "number" && Number.isFinite(gas)) ? String(gas) : gas !== undefined ? "non valido" : "stimato al momento dell'invio"}`);
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
  const issue = evmPayloadIssue(p);
  if (issue === "MALFORMED: data")
    return [{ text: UNKNOWN, risk: "unknown" }, { text: BAD_DATA_WARNING, risk: "high" }];
  if (issue === "MALFORMED: value")
    return [{ text: UNKNOWN, risk: "unknown" }, { text: BAD_VALUE_WARNING, risk: "high" }];
  let tok: { symbol: string; decimals: number } | undefined;
  try { tok = evmTokens()[getAddress(p.to)]; } catch { /* invalid to */ }
  const native = evmNative(p.chainId);
  const valueOk = asAmount((p as { value?: unknown }).value) ?? 0n;
  const trunc = isMalformedApproval(p.data);
  if (trunc)
    return [{ text: MALFORMED_APPROVAL_TEXT, risk: "high" }];
  const d = decodeEvm(p.data);
  if (!p.data || p.data === "0x")
    return [{ text: `Stai inviando ${formatUnitsIt(valueOk, 18)} ${native} a ${p.to} su ${p.network}.`, risk: "normal" }];
  if (!d) return [{ text: UNKNOWN, risk: "unknown" }];
  const extra = valueOk > 0n ? `, allegando ${formatUnitsIt(valueOk, 18)} ${native}` : "";
  const amt = (v: unknown) => (tok && typeof v === "bigint" ? `${formatUnitsIt(v, tok.decimals)} ${tok.symbol}` : `${String(v)} unità del token ${p.to}`);
  const unlimitedOf = (spender: unknown, verb: string) =>
    ({ text: `RISCHIO ALTO: ${verb} ${String(spender)} a spendere una quantità ILLIMITATA di ${tok?.symbol ?? "token"} su ${p.network}. È un permesso totale.`, risk: "high" as const });
  if (d.method === "transfer")
    return [{ text: `Stai inviando ${amt(d.args.amount)} a ${String(d.args.to)} tramite il metodo transfer su ${p.network}${extra}.`, risk: "normal" }];
  if (d.method === "approve") {
    if (d.args.amount === maxUint256) return [unlimitedOf(d.args.spender, "stai autorizzando")];
    return [{ text: `Stai autorizzando ${String(d.args.spender)} a spendere fino a ${amt(d.args.amount)} su ${p.network}${extra}.`, risk: "normal" }];
  }
  if (d.method === "increaseAllowance") {
    const added = d.args.addedValue;
    if (added === maxUint256)
      return [{ text: `RISCHIO ALTO: stai aumentando l'autorizzazione di ${String(d.args.spender)} di una quantità ILLIMITATA di ${tok?.symbol ?? "token"} su ${p.network}. È un permesso totale.`, risk: "high" }];
    return [{ text: `Stai aumentando l'autorizzazione di ${String(d.args.spender)} di ${amt(added)} su ${p.network}${extra}.`, risk: "normal" }];
  }
  if (d.method === "permit" && (d.style === "dai-permit" || "allowed" in d.args)) {
    if (d.args.allowed === true)
      return [{ text: `RISCHIO ALTO: stai firmando un permit DAI che autorizza ${String(d.args.spender)} a spendere una quantità ILLIMITATA di ${tok?.symbol ?? "token"} su ${p.network}. È un permesso totale.`, risk: "high" }];
    return [{ text: `Stai firmando un permit DAI che revoca l'autorizzazione di ${String(d.args.spender)} su ${p.network}.`, risk: "normal" }];
  }
  if (d.method === "permit") {
    if (d.args.value === maxUint256)
      return [{ text: `RISCHIO ALTO: stai firmando un permit che autorizza ${String(d.args.spender)} a spendere una quantità ILLIMITATA di ${tok?.symbol ?? "token"} su ${p.network}. È un permesso totale.`, risk: "high" }];
    return [{ text: `Stai firmando un permit che autorizza ${String(d.args.spender)} a spendere fino a ${amt(d.args.value)} su ${p.network}${extra}.`, risk: "normal" }];
  }
  if (d.method === "setApprovalForAll") {
    if (d.args.approved === true)
      return [{ text: `RISCHIO ALTO: stai dando a ${String(d.args.operator)} il permesso TOTALE di gestire tutti i tuoi NFT del contratto ${p.to} su ${p.network} (setApprovalForAll).`, risk: "high" }];
    return [{ text: `Stai revocando a ${String(d.args.operator)} il permesso di gestire tutti i tuoi NFT del contratto ${p.to} su ${p.network}.`, risk: "normal" }];
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

type GuardEvent = QueueEvent;

export const lowerPlanId = (id: string): `0x${string}` => {
  const s = id.trim();
  return (s.startsWith("0x") || s.startsWith("0X") ? s : `0x${s}`).toLowerCase() as `0x${string}`;
};

export function guardEvent(o: {
  kind: QueueEvent["kind"];
  planId: string;
  reason: string;
  amount: bigint;
  now: number;
  id?: string | null;
}): QueueEvent {
  // Never crash on a non-finite now: the caller must have already blocked with BAD_NOW
  // and must not have written state. The timestamp on the event itself stays a valid ISO string.
  const ts = Number.isFinite(o.now) ? new Date(o.now).toISOString() : new Date().toISOString();
  const amount = typeof o.amount === "bigint" ? o.amount : 0n;
  return {
    kind: o.kind,
    planId: lowerPlanId(o.planId),
    reason: o.reason,
    amount,
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
  | "BAD_NOW"
  | "BAD_CONFIG"
  | "MALFORMED"
  | "MalformedApproval"
  | "MissingAmount"
  | "AmountMismatch"
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
  o: {
    now?: number | bigint;
    ttlMs?: number | bigint;
    nonce?: string | number;
    log?: (e: QueueEvent) => void;
    amount?: bigint;
    store?: ConsentStore;
  } = {},
): Consent {
  const fail = (code: ConsentReason, reason: string, at: number): never => {
    const ev = guardEvent({
      kind: "blocked",
      planId: typeof view?.payloadHash === "string" ? lowerPlanId(view.payloadHash) : ZERO_HASH,
      reason,
      amount: typeof o.amount === "bigint" ? o.amount : 0n,
      now: Number.isFinite(at) ? at : Date.now(),
      id: null,
    });
    o.log?.(ev);
    throw new ConsentError(code, reason, ev);
  };

  let issuedAt: number;
  if ("now" in o && o.now !== undefined) {
    const n = asFiniteNumber(o.now);
    if (n === undefined) return fail("BAD_NOW", "BAD_NOW", Date.now());
    issuedAt = n;
  } else {
    issuedAt = Date.now();
  }
  if (o.store && !o.store.acceptNow(issuedAt)) fail("BAD_NOW", "BAD_NOW", Date.now());

  let ttl: number;
  if ("ttlMs" in o && o.ttlMs !== undefined) {
    const t = asFiniteNumber(o.ttlMs);
    if (t === undefined || t <= 0) return fail("BAD_CONFIG", "BAD_CONFIG: ttlMs", issuedAt);
    ttl = Math.min(t, CONSENT_TTL_MS);
  } else {
    ttl = CONSENT_TTL_MS;
  }

  const consent: Consent = {
    payloadHash: lowerPlanId(view.payloadHash),
    nonce: normNonce(o.nonce) ?? randomNonce(),
    issuedAt,
    expiresAt: issuedAt + ttl,
  };
  o.log?.(
    guardEvent({
      kind: "queued",
      planId: consent.payloadHash,
      reason: "ConsentShown",
      amount: typeof o.amount === "bigint" ? o.amount : 0n,
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
export type ConsentHistory = { status: Stored["status"]; amount: bigint; nonce: string };

export class ConsentStore {
  private recs = new Map<string, Stored>();
  private seenPlanIds = new Set<string>();
  /** Per-planId final record. Survives prune and remove, so a recreate cannot reset history. */
  private history = new Map<string, ConsentHistory>();
  private lastNow: number | undefined;
  private seq = 0;

  /**
   * Accept a clock value: must be finite and not earlier than the last value seen.
   * On failure, write no state (including lastNow). On success, remember `now`.
   */
  acceptNow(now: number): boolean {
    if (!Number.isFinite(now)) return false;
    if (this.lastNow !== undefined && now < this.lastNow) return false;
    this.lastNow = now;
    return true;
  }

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
    this.history.set(row.planId, { status: row.status, amount: row.amount, nonce: row.nonce });
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
  historyOf = (planId: string) => this.history.get(lowerPlanId(planId));
  /**
   * Drops the live record only. History and seen planIds stay, so removing and
   * re-creating a consent with the same id cannot reset replay or limits.
   */
  remove = (nonce: unknown) => {
    const n = normNonce(nonce);
    if (n === undefined) return;
    this.recs.delete(n);
  };
  /** True if this planId was already consented or consumed (replay). */
  wasUsed = (planId: string) => {
    const id = lowerPlanId(planId);
    const h = this.history.get(id);
    if (h && (h.status === "consented" || h.status === "consumed" || h.status === "rejected" || h.status === "expired")) return true;
    if (!this.seenPlanIds.has(id)) return false;
    for (const r of this.recs.values()) {
      if (r.planId === id && (r.status === "consented" || r.status === "consumed" || r.status === "rejected" || r.status === "expired")) return true;
    }
    return this.seenPlanIds.has(id);
  };
  prune = (now: number, windowMs = CONSENT_WINDOW_MS) => {
    // Invalid clock or window: write no state.
    if (!Number.isFinite(now)) return;
    if (this.lastNow !== undefined && now < this.lastNow) return;
    if (!Number.isFinite(windowMs) || windowMs <= 0) return;
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
  o?: { store?: ConsentStore; now?: unknown; log?: (r: QueueEvent) => void; amount?: bigint },
): VerifyResult {
  const log = o && typeof o === "object" ? o.log : undefined;
  const store = o && typeof o === "object" ? o.store : undefined;
  const nowRaw = o && typeof o === "object" && "now" in o && o.now !== undefined ? o.now : Date.now();
  const now = asFiniteNumber(nowRaw);
  const knownAmount = o && typeof o === "object" ? asAmount(o.amount) : undefined;

  const fail = (kind: QueueEvent["kind"], reason: ConsentReason, planId: `0x${string}`, amount: bigint, nonce?: string, at?: number): VerifyResult => {
    const record = guardEvent({ kind, planId, reason, amount, now: Number.isFinite(at) ? at! : (now !== undefined ? now : Date.now()), id: nonce ?? null });
    log?.(record);
    return { ok: false, reason, record };
  };

  try {
    const amountHint = (p: unknown) => knownAmount ?? payloadAmount(p);
    if (now === undefined) {
      return fail("blocked", "BAD_NOW", planIdOf(current), amountHint(current), undefined, Date.now());
    }
    if (store && !store.acceptNow(now)) {
      return fail("blocked", "BAD_NOW", planIdOf(current), amountHint(current), undefined, Date.now());
    }
    if (!isPayload(current)) return fail("blocked", "ConsentMalformed", ZERO_HASH, knownAmount ?? 0n);
    const fieldIssue = evmPayloadIssue(current);
    if (fieldIssue === "MalformedApproval") return fail("blocked", "MalformedApproval", planIdOf(current), knownAmount ?? payloadAmount(current));
    if (fieldIssue) return fail("blocked", "MALFORMED", planIdOf(current), knownAmount ?? 0n);
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
    const hist = store.historyOf(planId);
    if (existing && (existing.status === "consented" || existing.status === "consumed" || existing.status === "rejected")) {
      return fail("blocked", "ConsentReplay", planId, amount, nonce);
    }
    if ((store.wasUsed(planId) || hist) && existing?.status !== "issued") {
      return fail("blocked", "ConsentReplay", planId, amount, nonce);
    }
    if (now > expiresAt || now < issuedAt) {
      if (existing) store.put({ ...existing, status: "expired", decidedAt: now });
      return fail("expired", "ConsentExpired", planId, amount, nonce);
    }
    if (hash !== planId) return fail("blocked", "ConsentPayloadMismatch", planId, amount, nonce);
    store.put({ nonce, planId, payloadHash: hash, status: "consented", issuedAt, expiresAt, amount, decidedAt: now });
    const event = guardEvent({ kind: "approved", planId, reason: "Consented", amount, now, id: nonce });
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
  o?: { store?: ConsentStore; now?: unknown; log?: (r: QueueEvent) => void; amount?: bigint },
): QueueEvent {
  const log = o?.log;
  const store = o?.store;
  const now = asFiniteNumber(o && "now" in (o ?? {}) && o?.now !== undefined ? o.now : Date.now());
  const amountProvided = o !== undefined && o !== null && typeof o === "object" && "amount" in o && o.amount !== undefined;
  const knownAmount = amountProvided ? asAmount(o.amount) : undefined;
  const emitThrow = (kind: QueueEvent["kind"], reason: ConsentReason, planId: `0x${string}`, amount: bigint, nonce?: string): never => {
    const event = guardEvent({ kind, planId, reason, amount, now: now !== undefined ? now : Date.now(), id: nonce ?? null });
    log?.(event);
    throw new ConsentError(reason, reason, event);
  };
  if (now === undefined) return emitThrow("blocked", "BAD_NOW", planIdOf(current), knownAmount ?? payloadAmount(current));
  if (store && !store.acceptNow(now)) return emitThrow("blocked", "BAD_NOW", planIdOf(current), knownAmount ?? payloadAmount(current));
  const approvalIssue = evmPayloadIssue(current);
  if (approvalIssue === "MalformedApproval") {
    return emitThrow("blocked", "MalformedApproval", planIdOf(current), knownAmount ?? payloadAmount(current));
  }
  if (!store) return emitThrow("blocked", "ConsentMalformed", planIdOf(current), knownAmount ?? payloadAmount(current));
  store.prune(now);
  const c = consent as Consent | null | undefined;
  const nonce = c && typeof c === "object" ? normNonce(c.nonce) : undefined;
  const row = nonce !== undefined ? store.get(nonce) : undefined;
  const planId = row?.planId ?? planIdOf(current);
  const hist = store.historyOf(planId);
  if (!amountProvided) {
    const amt = row?.amount ?? hist?.amount ?? payloadAmount(current);
    return emitThrow("blocked", "MissingAmount", planId, amt, nonce);
  }
  if (knownAmount === undefined) return emitThrow("blocked", "MALFORMED", planId, row?.amount ?? hist?.amount ?? 0n, nonce);
  const amount = knownAmount;
  if (!row || nonce === undefined) {
    if (hist?.status === "consumed") return emitThrow("blocked", "Consumed", planId, amount, nonce);
    if (hist?.status === "rejected") return emitThrow("blocked", "ConsentRejected", planId, amount, nonce);
    if (hist?.status === "expired") return emitThrow("expired", "Expired", planId, amount, nonce);
    return emitThrow("blocked", "NotConsented", planId, amount, nonce);
  }
  if (row.status === "consumed") return emitThrow("blocked", "Consumed", planId, amount, nonce);
  if (row.status === "rejected") return emitThrow("blocked", "ConsentRejected", planId, amount, nonce);
  if (row.status === "expired" || now > row.expiresAt) {
    store.put({ ...row, status: "expired", decidedAt: now });
    return emitThrow("expired", "Expired", planId, amount, nonce);
  }
  if (row.status !== "consented") return emitThrow("blocked", "NotConsented", planId, amount, nonce);
  if (isPayload(current) && lowerPlanId(approvalView(current).payloadHash) !== row.planId) {
    return emitThrow("blocked", "ConsentPayloadMismatch", planId, amount, nonce);
  }
  if (amount !== row.amount) return emitThrow("blocked", "AmountMismatch", planId, amount, nonce);
  store.put({ ...row, status: "consumed", decidedAt: now, amount });
  const event = guardEvent({ kind: "consumed", planId, reason: "Consumed", amount, now, id: nonce });
  log?.(event);
  return event;
}

/** The approver pressed "Rifiuta": log it and burn the nonce so it can never be used. Never throws. */
export function rejectConsent(
  consent: unknown,
  current: unknown,
  o?: { store?: ConsentStore; now?: unknown; log?: (r: QueueEvent) => void; amount?: bigint },
): QueueEvent {
  try {
    const c = consent as Consent | null | undefined;
    const nonce = c && typeof c === "object" ? normNonce(c.nonce) : undefined;
    let now: number;
    if (o && typeof o === "object" && "now" in o && o.now !== undefined) {
      const n = asFiniteNumber(o.now);
      if (n === undefined) {
        const r = guardEvent({ kind: "blocked", planId: planIdOf(current), reason: "BAD_NOW", amount: asAmount(o?.amount) ?? payloadAmount(current), now: Date.now(), id: nonce ?? null });
        o?.log?.(r);
        return r;
      }
      now = n;
    } else {
      now = Date.now();
    }
    if (o?.store && !o.store.acceptNow(now)) {
      const r = guardEvent({ kind: "blocked", planId: planIdOf(current), reason: "BAD_NOW", amount: asAmount(o?.amount) ?? payloadAmount(current), now: Date.now(), id: nonce ?? null });
      o.log?.(r);
      return r;
    }
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
/** Exact field names whose 0x+64 hex may stay visible. Never a substring match. */
const KEEP_HEX = new Set(["planhash", "txhash", "transactionhash", "blockhash", "root", "merkleroot", "planid"]);
const SENSITIVE_SUB = /key|secret|priv|seed|mnemonic|password|salt/i;

function keyLooksSensitive(k: string): boolean {
  if (SECRET_KEY.test(k)) return true;
  if (SENSITIVE_SUB.test(k)) return true;
  return false;
}

function looksLikeJwtOrPhrase(s: string): boolean {
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s)) return true;
  if (/^Bearer\s+\S+/i.test(s.trim())) return true;
  const words = s.trim().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

function redactString(k: string | null, s: string): string {
  if (k !== null && keyLooksSensitive(k)) return "[redacted]";
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
    return k !== null && KEEP_HEX.has(k.toLowerCase()) ? s : "[redacted]";
  }
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return s;
  if (looksLikeJwtOrPhrase(s)) return "[redacted]";
  return s;
}

/** Redact secrets in a log payload. Does not touch approval text. */
export function redactSecrets(v: unknown, key: string | null = null): unknown {
  if (typeof v === "string") return redactString(key, v);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((item) => redactSecrets(item, key));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = redactSecrets(val, k);
  }
  return out;
}
