/** Redact secrets in log payloads. Looks at field NAMES (word-boundary) and VALUES. */

const SECRET_KEY = /^(authorization|bearer|jwt|auth|recovery_phrase|sig|sk|pk|secret|seed|password|passphrase|private_?key|mnemonic)$/i;
/** Legitimate fields that must stay visible even if they contain the substring "token" or "sig". */
const ALLOW_KEY = /^(tokenIn|tokenOut|tokenAddress|tokenSymbol|signatureCount|seededAt|passed)$/i;
const HASH_KEY = /(hash|plan|tx|block|message|topic|id)$/i;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const JWT = /^eyJ[A-Za-z0-9_-]+\./;
const BEARER = /^Bearer\s+\S+/i;
const BIP39 = /^(?:[a-z]{3,15}\s+){11}(?:[a-z]{3,15}\s+){0,12}[a-z]{3,15}$/;

const REDACTED = "[redacted]";

export function looksLikeSecretValue(v: string): boolean {
  const s = v.trim();
  return HEX64.test(s) || JWT.test(s) || BEARER.test(s) || BIP39.test(s);
}

export function redactSecrets<T>(input: T, key = ""): T {
  if (input == null || typeof input !== "object") {
    if (typeof input === "string" && key && ALLOW_KEY.test(key)) return input;
    if (typeof input === "string" && (SECRET_KEY.test(key) || (looksLikeSecretValue(input) && !HASH_KEY.test(key)))) {
      return REDACTED as T;
    }
    return input;
  }
  if (Array.isArray(input)) return input.map((x, i) => redactSecrets(x, `${key}[${i}]`)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (ALLOW_KEY.test(k)) out[k] = v;
    else if (SECRET_KEY.test(k)) out[k] = REDACTED;
    else out[k] = redactSecrets(v, k);
  }
  return out as T;
}
