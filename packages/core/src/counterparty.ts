import { isAddress, type Address, type Hex } from "viem";
import { blockedEvent, normalizeAddress, normalizePlanId, normalizeToken, type QueueEvent } from "./events";
import { redactSecrets } from "./redact";
import { parseCount } from "./simulate";
import { tightenNumber } from "./limits";

/**
 * Counterparty check before paying (idea: Reins). Read-only: eth_getCode plus local lists.
 * Fail-closed: missing or invalid data never yields verdict "ok".
 * Blocks use the shared QueueEvent (kind "blocked", planId lowercase, amount bigint).
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
  /** A first-time payee is blocked instead of warned. */
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
    | "SimUnavailable"
    | "BadConfig";
  severity: "ok" | "warning" | "blocked";
  detail: string;
};

export type CounterpartyVerdict = {
  verdict: "ok" | "warning" | "blocked";
  address?: `0x${string}`;
  kind?: "eoa" | "contract" | "zero" | "unknown";
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

const asAddrList = (x: unknown): `0x${string}`[] => {
  if (!Array.isArray(x)) return [];
  const out: `0x${string}`[] = [];
  for (const i of x) {
    if (typeof i !== "string") continue;
    const v = i.trim().toLowerCase();
    if (isAddress(v)) out.push(normalizeAddress(v));
  }
  return out;
};

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
  if (typeof x === "string") {
    try { return normalizePlanId(x); } catch { /* fall through */ }
  }
  return ("0x" + "00".repeat(32)) as `0x${string}`;
}

function amountOf(x: unknown): bigint {
  if (x === undefined) return 0n;
  const p = parseCount(x, "amount");
  return p.ok && p.value >= 0n ? p.value : 0n;
}

/** Check a payee before sending. Never throws. */
export async function checkCounterparty(input: CounterpartyInput | null | undefined, client?: CodeClient | null): Promise<CounterpartyVerdict> {
  const at = Number.isFinite(input?.now) ? Number(input!.now) : (input?.now === undefined ? Date.now() : NaN);
  const findings: Finding[] = [];
  const token = typeof input?.token === "string" && input.token.trim() ? normalizeToken(input.token) : undefined;
  const planId = planIdOf(input?.planId);
  const amount = amountOf(input?.amount);
  const emit = (reason: Finding["code"] | "SimUnavailable", extra?: Partial<CounterpartyVerdict>): CounterpartyVerdict => {
    const verdict = "blocked" as const;
    const event = blockedEvent({ planId, reason, amount, ts: Number.isFinite(at) ? at : Date.now() });
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
    const address = normalizeAddress(input.address);
    const allow = asAddrList(input.allowlist);
    const deny = asAddrList(input.denylist);
    const paid = asAddrList(input.paidBefore);
    const known = [...new Set([...allow, ...paid, ...asAddrList(input.known)])];
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
      findings.push({ code: "SimUnavailable", severity: "blocked", detail: "client RPC assente: eth_getCode non eseguito" });
    } else {
      try {
        const code = await client.getCode({ address: address as Address });
        const hasCode = typeof code === "string" && code !== "" && code !== "0x";
        if (address !== ZERO) kind = hasCode ? "contract" : "eoa";
        if (kind === "contract") findings.push({ code: "CounterpartyContract", severity: "warning", detail: `${address} è un contratto (eth_getCode)` });
        else if (kind === "eoa") findings.push({ code: "CounterpartyEoa", severity: "ok", detail: `${address} è un EOA (eth_getCode vuoto)` });
      } catch (e) {
        findings.push({ code: "SimUnavailable", severity: "blocked", detail: `eth_getCode: ${e instanceof Error ? e.message : String(e)}` });
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
