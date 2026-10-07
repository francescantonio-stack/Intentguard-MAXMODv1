import { DECIMALS, type Token } from "./chains";

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Decimal string ("1.5") -> base units (bigint). Never goes through JS floats. */
export function toUnits(amount: string, token: Token): bigint {
  if (!DECIMAL_RE.test(amount)) throw new Error(`invalid amount "${amount}"`);
  const decimals = DECIMALS[token];
  const [whole = "0", frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals for ${token}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units -> decimal string, trailing zeros trimmed ("1500000" USDC -> "1.5"). */
export function fromUnits(units: bigint, token: Token): string {
  const decimals = BigInt(DECIMALS[token]);
  const base = 10n ** decimals;
  const whole = units / base;
  const frac = (units % base).toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Fraction in (0, 1] -> basis points, rounded. Fractions are ratios, not amounts. */
export function fractionToBps(fraction: number): bigint {
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`fraction ${fraction} out of (0, 1]`);
  return BigInt(Math.round(fraction * 10_000));
}
