/**
 * Shared limit/config rules (Primo):
 * - every config value is checked up front: finite and > 0 (sensible minimums), else BadConfig
 * - a value coming from a source or from input may only TIGHTEN a default, never loosen it
 * - numeric strings, NaN, Infinity, -0, null, bigint in place of a number: BadConfig
 */

export const isNegZero = (x: unknown): boolean => typeof x === "number" && Object.is(x, -0);

/** Strict number for limits: no strings, bigint, NaN, Inf, -0. Not exported (guards.asFiniteNumber is the shared helper). */
function asLimitNumber(x: unknown): number | undefined {
  if (typeof x !== "number" || !Number.isFinite(x) || isNegZero(x)) return undefined;
  return x;
}

export function asPositiveNumber(x: unknown): number | undefined {
  const n = asLimitNumber(x);
  return n !== undefined && n > 0 ? n : undefined;
}

export function asPositiveInt(x: unknown): number | undefined {
  const n = asPositiveNumber(x);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/**
 * Apply a numeric limit. `largerIsLooser` (default): offered may only be <= default
 * (timeout, maxAge, lookalikeChars). If larger is tighter, set largerIsLooser=false.
 */
export function tightenNumber(
  offered: unknown,
  def: number,
  largerIsLooser = true,
): { ok: true; value: number } | { ok: false; reason: "BadConfig"; detail: string } {
  if (offered === undefined || offered === null) return { ok: true, value: def };
  const wantInt = Number.isInteger(def);
  const n = wantInt ? asPositiveInt(offered) : asPositiveNumber(offered);
  if (n === undefined) return { ok: false, reason: "BadConfig", detail: "limite non è un numero finito > 0" };
  if (largerIsLooser ? n > def : n < def) {
    return { ok: false, reason: "BadConfig", detail: `limite allargato dalla fonte o dall'input (default ${def}, offerto ${n})` };
  }
  return { ok: true, value: n };
}

export function tightenBigint(
  offered: unknown,
  def: bigint,
  largerIsLooser = true,
): { ok: true; value: bigint } | { ok: false; reason: "BadConfig"; detail: string } {
  if (offered === undefined || offered === null) return { ok: true, value: def };
  if (typeof offered !== "bigint" || offered <= 0n) {
    return { ok: false, reason: "BadConfig", detail: "limite non è un bigint > 0" };
  }
  if (largerIsLooser ? offered > def : offered < def) {
    return { ok: false, reason: "BadConfig", detail: `limite allargato dalla fonte o dall'input (default ${def}, offerto ${offered})` };
  }
  return { ok: true, value: offered };
}

/**
 * Time/size config: omitted or null -> default.
 * Must be a finite number > 0 and <= max (max is a hard ceiling, distinct from the default).
 * Values above max are BadConfig: never silently accepted or clamped.
 */
export function cappedNumber(
  offered: unknown,
  def: number,
  max: number,
): { ok: true; value: number } | { ok: false; reason: "BadConfig"; detail: string } {
  if (offered === undefined || offered === null) return { ok: true, value: def };
  const wantInt = Number.isInteger(def) && Number.isInteger(max);
  const n = wantInt ? asPositiveInt(offered) : asPositiveNumber(offered);
  if (n === undefined) return { ok: false, reason: "BadConfig", detail: "limite non è un numero finito > 0" };
  if (n > max) return { ok: false, reason: "BadConfig", detail: `limite sopra il massimo (${max}, offerto ${n})` };
  return { ok: true, value: n };
}

/** True when `config` is a plain object. `null` is not an object here (use defaults at the call site). */
export function isConfigObject(config: unknown): config is Record<string, unknown> {
  return config !== null && typeof config === "object" && !Array.isArray(config);
}
