import { isAddress, type Address, type Hex } from "viem";
import type { QueueEvent } from "./events";
import { asAmount as asAmountGuard, blockedEvent, lowerAddress, lowerPlanId, upperToken } from "./guards";
import { redactSecrets } from "./redact";
import { tightenNumber } from "./limits";

/**
 * Counterparty check before paying (idea: Reins). Read-only: eth_getCode plus local lists.
 * Fail-closed: missing or invalid data never yields verdict "ok".
 * Blocks use the shared QueueEvent (kind "blocked", planId lowercase, amount bigint).
 *
 * `blockNew` default is false: a first-time payee is a warning, not a block.
 * Pass `blockNew: true` to refuse new counterparties.
 * EIP-7702 code (`0xef0100…`) is a delegated EOA (finding Delegated7702, warning), not a plain contract.
 */

export type CodeClient = { getCode: (a: { address: Address }) => Promise<Hex | undefined | string> };

export type CounterpartyInput = {
  address?: unknown;
  chainId?: unknown;
  amount?: unknown;
  planId?: unknown;
  token?: unknown;
  allowlist?: unknown;
  denylist?: unknown;
  paidBefore?: unknown;
  known?: unknown;
  /** If the allowlist is non-empty, an address not on it is blocked (default: warning). */
  strictAllowlist?: boolean;
  /** If true, a first-time payee is blocked. Default: false (warning only). */
  blockNew?: boolean;
  /** Hex chars to match at each end for address-poisoning (default 4). May only tighten (smaller), never widen. */
  lookalikeChars?: unknown;
  now?: unknown;
  config?: { lookalikeChars?: unknown };
};

/** Default lookalike window: first and last 4 hex chars. Input may only lower this. */
export const COUNTERPARTY_DEFAULTS = { lookalikeChars: 4 } as const;

export type Finding = {
  code:
    | "ZeroAddress"
    | "CounterpartyDenylisted"
    | "LookalikeAddress"
    | "NewCounterparty"
    | "CounterpartyContract"
    | "CounterpartyEoa"
    | "Allowlisted"
    | "NotAllowlisted"
    | "Delegated7702"
    | "CodeUnavailable"
    | "BadAmount"
    | "SimUnavailable"
    | "BadConfig";
  severity: "ok" | "warning" | "blocked";
  detail: string;
};

export type CounterpartyVerdict = {
  verdict: "ok" | "warning" | "blocked";
  address?: `0x${string}`;
  kind?: "eoa" | "contract" | "delegated" | "zero" | "unknown";
  token?: string;
  findings: Finding[];
  event: QueueEvent | null;
  safeHoldInput: {
    intent: unknown;
    now: number;
    required: string[];
    observations: Array<{ key: string; value: number; observedAt: number; source: string; confidence: number }>;
  };
  successOddsInput: { dryRun: Array<{ ok: boolean; reason?: string }> };
  checkedAt: number;
};

const ZERO = "0x" + "00".repeat(20);

/** Absent (undefined) → empty list. Present but not an array, or any invalid entry → BadConfig. */
function parseAddrList(x: unknown, field: string): { ok: true; value: `0x${string}`[] } | { ok: false; detail: string } {
  if (x === undefined) return { ok: true, value: [] };
  if (!Array.isArray(x)) return { ok: false, detail: `${field} non è una lista` };
  const out: `0x${string}`[] = [];
  for (const i of x) {
    if (typeof i !== "string") return { ok: false, detail: `${field} contiene voci non valide` };
    const v = i.trim().toLowerCase();
    if (!isAddress(v)) return { ok: false, detail: `${field} contiene voci non valide` };
    const addr = lowerAddress(v);
    if (!addr) return { ok: false, detail: `${field} contiene voci non valide` };
    out.push(addr);
  }
  return { ok: true, value: out };
}

export function isLookalike(a: string, b: string, n = 4): boolean {
  if (!Number.isInteger(n) || n < 2) n = 4;
  const x = a.trim().toLowerCase().replace(/^0x/, "");
  const y = b.trim().toLowerCase().replace(/^0x/, "");
  if (x.length !== 40 || y.length !== 40 || x === y) return false;
  return x.slice(0, n) === y.slice(0, n) && x.slice(-n) === y.slice(-n);
}

const toCpSafeHold = (v: CounterpartyVerdict["verdict"], at: number, intent?: unknown) => ({
  intent: intent === undefined ? undefined : redactSecrets(intent),
  now: at,
  required: ["counterparty:ok"],
  observations: [{
    key: "counterparty:ok",
    value: v === "blocked" ? 0 : 1,
    observedAt: at,
    source: "counterparty",
    confidence: v === "ok" ? 1 : v === "warning" ? 0.7 : 0,
  }],
});

function planIdOf(x: unknown): `0x${string}` {
  return lowerPlanId(x) ?? ("0x" + "00".repeat(32)) as `0x${string}`;
}

function amountOf(x: unknown): { ok: true; value: bigint } | { ok: false } {
  if (x === undefined) return { ok: true, value: 0n };
  const v = asAmountGuard(x);
  return v === null ? { ok: false } : { ok: true, value: v };
}

/** Check a payee before sending. Never throws. */
export async function checkCounterparty(input: CounterpartyInput | null | undefined, client?: CodeClient | null): Promise<CounterpartyVerdict> {
  const at = Number.isFinite(input?.now) ? Number(input!.now) : (input?.now === undefined ? Date.now() : NaN);
  const findings: Finding[] = [];
  const token = upperToken(input?.token) ?? undefined;
  const planId = planIdOf(input?.planId);
  const parsedAmountEarly = amountOf(input?.amount);
  const amountForEvent = parsedAmountEarly.ok ? parsedAmountEarly.value : 0n;
  const emit = (reason: Finding["code"], extra?: Partial<CounterpartyVerdict>): CounterpartyVerdict => {
    const verdict = "blocked" as const;
    const event = blockedEvent({ planId, reason, amount: amountForEvent, ts: Number.isFinite(at) ? at : Date.now() });
    const v: CounterpartyVerdict = {
      verdict, findings, event, token, checkedAt: Number.isFinite(at) ? at : Date.now(),
      safeHoldInput: toCpSafeHold(verdict, Number.isFinite(at) ? at : Date.now(), input),
      successOddsInput: { dryRun: [{ ok: false, reason }] },
      ...extra,
    };
    v.safeHoldInput = toCpSafeHold(verdict, v.checkedAt, input);
    return v;
  };

  try {
    if (input == null || typeof input !== "object") {
      findings.push({ code: "SimUnavailable", severity: "blocked", detail: "input assente" });
      return emit("SimUnavailable");
    }
    if (input.now !== undefined && !Number.isFinite(Number(input.now))) {
      findings.push({ code: "SimUnavailable", severity: "blocked", detail: "BAD_NOW: now non è un numero finito" });
      return emit("SimUnavailable");
    }
    if (typeof input.address !== "string" || !isAddress(input.address)) {
      findings.push({ code: "SimUnavailable", severity: "blocked", detail: "indirizzo destinatario mancante o non valido" });
      return emit("SimUnavailable");
    }
    const address = lowerAddress(input.address);
    if (!address) {
      findings.push({ code: "SimUnavailable", severity: "blocked", detail: "indirizzo destinatario mancante o non valido" });
      return emit("SimUnavailable");
    }
    if (input.config !== undefined && (input.config == null || typeof input.config !== "object" || Array.isArray(input.config))) {
      findings.push({ code: "BadConfig", severity: "blocked", detail: "config non valida" });
      return emit("BadConfig", { address });
    }
    const parsedAmount = amountOf(input.amount);
    if (!parsedAmount.ok) {
      findings.push({ code: "BadAmount", severity: "blocked", detail: "amount mancante o non valido" });
      return emit("BadAmount", { address });
    }
    // shadow the outer amount (invalid must not become 0n and proceed)
    const amount = parsedAmount.value;
    const allowR = parseAddrList(input.allowlist, "allowlist");
    const denyR = parseAddrList(input.denylist, "denylist");
    const paidR = parseAddrList(input.paidBefore, "paidBefore");
    const knownR = parseAddrList(input.known, "known");
    if (!allowR.ok) { findings.push({ code: "BadConfig", severity: "blocked", detail: allowR.detail }); return emit("BadConfig", { address }); }
    if (!denyR.ok) { findings.push({ code: "BadConfig", severity: "blocked", detail: denyR.detail }); return emit("BadConfig", { address }); }
    if (!paidR.ok) { findings.push({ code: "BadConfig", severity: "blocked", detail: paidR.detail }); return emit("BadConfig", { address }); }
    if (!knownR.ok) { findings.push({ code: "BadConfig", severity: "blocked", detail: knownR.detail }); return emit("BadConfig", { address }); }
    const allow = allowR.value;
    const deny = denyR.value;
    const paid = paidR.value;
    const known = [...new Set([...allow, ...paid, ...knownR.value])];
    const offeredChars = input.config?.lookalikeChars ?? input.lookalikeChars;
    const look = tightenNumber(offeredChars, COUNTERPARTY_DEFAULTS.lookalikeChars, true);
    if (!look.ok) {
      findings.push({ code: "BadConfig", severity: "blocked", detail: look.detail });
      return emit("BadConfig", { address });
    }
    const lookN = look.value;

    if (address === ZERO) {
      findings.push({ code: "ZeroAddress", severity: "blocked", detail: "indirizzo zero" });
    }
    if (deny.includes(address)) {
      findings.push({ code: "CounterpartyDenylisted", severity: "blocked", detail: `${address} è in denylist` });
    }
    const twin = known.find((k) => isLookalike(address, k, lookN));
    if (twin) {
      findings.push({ code: "LookalikeAddress", severity: "blocked", detail: `${address} somiglia a ${twin} (primi e ultimi ${lookN} caratteri)` });
    }
    if (allow.includes(address)) {
      findings.push({ code: "Allowlisted", severity: "ok", detail: `${address} è in allowlist` });
    } else if (allow.length > 0) {
      findings.push({
        code: "NotAllowlisted",
        severity: input.strictAllowlist ? "blocked" : "warning",
        detail: `${address} non è in allowlist`,
      });
    }
    const seen = new Set([...paid, ...allow]);
    if (!seen.has(address) && address !== ZERO) {
      findings.push({
        code: "NewCounterparty",
        severity: input.blockNew ? "blocked" : "warning",
        detail: `${address} non è mai stato pagato prima`,
      });
    }

    let kind: CounterpartyVerdict["kind"] = "unknown";
    if (address === ZERO) kind = "zero";
    if (!client || typeof client.getCode !== "function") {
      findings.push({ code: "CodeUnavailable", severity: "blocked", detail: "client RPC assente: eth_getCode non eseguito" });
    } else {
      try {
        const code = await client.getCode({ address: address as Address });
        const raw = typeof code === "string" ? code.toLowerCase() : "";
        const isEoa = raw === "0x";
        const is7702 = /^0xef0100[0-9a-f]*$/.test(raw) && raw.length >= 14;
        const isContract = /^0x[0-9a-f]+$/.test(raw) && raw.length > 2 && !is7702;
        if (address !== ZERO) {
          if (isEoa) {
            kind = "eoa";
            findings.push({ code: "CounterpartyEoa", severity: "ok", detail: `${address} è un EOA (eth_getCode vuoto)` });
          } else if (is7702) {
            kind = "delegated";
            findings.push({ code: "Delegated7702", severity: "warning", detail: `${address} è un EOA delegato EIP-7702 (prefisso 0xef0100), non un contratto semplice` });
          } else if (isContract) {
            kind = "contract";
            findings.push({ code: "CounterpartyContract", severity: "warning", detail: `${address} è un contratto (eth_getCode)` });
          } else {
            // undefined, "", or non-hex: fail-closed, never treat as EOA
            findings.push({ code: "CodeUnavailable", severity: "blocked", detail: "eth_getCode non ha restituito un bytecode valido (serve '0x' esplicito per un EOA)" });
          }
        }
      } catch (e) {
        findings.push({ code: "CodeUnavailable", severity: "blocked", detail: `eth_getCode: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    const blocked = findings.filter((f) => f.severity === "blocked");
    const warned = findings.filter((f) => f.severity === "warning");
    const verdict: CounterpartyVerdict["verdict"] = blocked.length ? "blocked" : warned.length ? "warning" : "ok";
    const reason = blocked[0]?.code ?? warned[0]?.code;
    const event = verdict === "blocked" && reason
      ? blockedEvent({ planId, reason, amount, ts: at })
      : null;
    return {
      verdict, address, kind, token, findings, event, checkedAt: at,
      safeHoldInput: toCpSafeHold(verdict, at, input),
      successOddsInput: { dryRun: [{ ok: verdict !== "blocked", reason: verdict === "blocked" ? reason : undefined }] },
    };
  } catch (e) {
    findings.push({ code: "SimUnavailable", severity: "blocked", detail: `CHECK_ERROR: ${e instanceof Error ? e.message : String(e)}` });
    return emit("SimUnavailable");
  }
}
