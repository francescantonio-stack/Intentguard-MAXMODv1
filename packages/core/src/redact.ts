/** Redact secrets in log payloads. Looks at field NAMES (word-boundary) and VALUES. */

const SECRET_KEY = /^(authorization|bearer|jwt|auth|recovery_phrase|sig|sk|pk|secret|seed|password|passphrase|private_?key|mnemonic|privKey|privateKeyId)$/i;
/** Fields that may stay visible even when the value looks like 0x+64 hex. Exact names only — never widen. */
export const KEEP_HEX = new Set(["planhash", "txhash", "transactionhash", "blockhash", "root", "merkleroot", "planid"]);
const ALLOW_KEY = /^(tokenIn|tokenOut|tokenAddress|tokenSymbol|signatureCount|seededAt|passed)$/i;
const SENSITIVE_SUB = /key|secret|priv|seed|mnemonic|password/i;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const JWT = /^eyJ[A-Za-z0-9_-]+\./;
const BEARER = /^Bearer\s+\S+/i;
const BIP39 = /^(?:[a-z]{3,15}\s+){11}(?:[a-z]{3,15}\s+){0,12}[a-z]{3,15}$/;

const REDACTED = "[redacted]";

export function looksLikeSecretValue(v: string): boolean {
  const s = v.trim();
  if (HEX40.test(s) && !HEX64.test(s)) return false; // 0x+40 addresses stay visible
  return HEX64.test(s) || JWT.test(s) || BEARER.test(s) || BIP39.test(s);
}

function keepHex(key: string, allow: Set<string> = KEEP_HEX): boolean {
  if (SENSITIVE_SUB.test(key)) return false;
  return allow.has(key.toLowerCase());
}

export type RedactConfig = { allowKeys?: unknown };

/** Config may only shrink the default allowlist, never add keys. */
export function checkRedactConfig(config?: RedactConfig): { ok: true; allow: Set<string> } | { ok: false; reason: "BadConfig"; detail: string } {
  if (config === undefined) return { ok: true, allow: KEEP_HEX };
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, reason: "BadConfig", detail: "config non valida" };
  }
  if (config.allowKeys === undefined) return { ok: true, allow: KEEP_HEX };
  if (!Array.isArray(config.allowKeys) || config.allowKeys.some((k) => typeof k !== "string")) {
    return { ok: false, reason: "BadConfig", detail: "allowKeys non è una lista di stringhe" };
  }
  const offered = config.allowKeys.map((k) => k.toLowerCase());
  const extra = offered.filter((k) => !KEEP_HEX.has(k));
  if (extra.length) return { ok: false, reason: "BadConfig", detail: `allowKeys allarga l'elenco: ${extra.join(", ")}` };
  return { ok: true, allow: new Set(offered) };
}

function redactWithAllow<T>(input: T, key: string, allow: Set<string>): T {
  if (input == null || typeof input !== "object") {
    if (typeof input === "string" && key && ALLOW_KEY.test(key)) return input;
    if (typeof input === "string" && (SECRET_KEY.test(key) || (looksLikeSecretValue(input) && !keepHex(key, allow)))) {
      return REDACTED as T;
    }
    return input;
  }
  if (Array.isArray(input)) return input.map((x, i) => redactWithAllow(x, `${key}[${i}]`, allow)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (ALLOW_KEY.test(k)) out[k] = v;
    else if (SECRET_KEY.test(k) || SENSITIVE_SUB.test(k) && !ALLOW_KEY.test(k)) out[k] = REDACTED;
    else out[k] = redactWithAllow(v, k, allow);
  }
  return out as T;
}

const allRedacted = (input: unknown): unknown => {
  if (input == null || typeof input !== "object") return typeof input === "string" ? REDACTED : input;
  if (Array.isArray(input)) return input.map(allRedacted);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = allRedacted(v);
  return out;
};

export function redactSecrets<T>(input: T, key = ""): T {
  return redactWithAllow(input, key, KEEP_HEX);
}

/** Like redactSecrets, but rejects a config that widens the allowlist (fail-closed: everything redacted). */
export function redactWithConfig<T>(input: T, config?: RedactConfig): { ok: boolean; value: T; reason?: "BadConfig"; detail?: string } {
  const c = checkRedactConfig(config);
  if (!c.ok) return { ok: false, value: allRedacted(input) as T, reason: "BadConfig", detail: c.detail };
  return { ok: true, value: redactWithAllow(input, "", c.allow) };
}
