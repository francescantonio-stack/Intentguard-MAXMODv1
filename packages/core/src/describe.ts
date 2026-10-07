import { fromUnits } from "./amounts";
import { IntentSchema, type Intent } from "./schema";
import type { Plan } from "./planner";

/** Human-readable plan, shown before the passkey approval (PWA) and returned to agents (MCP). */
export function summarizePlan(plan: Plan): string[] {
  const lines = plan.steps.map((s, i) => `${i + 1}. [${s.chain}] ${s.label}`);
  const ex = plan.executorPlan;
  if (ex) {
    if (ex.swapAmount > 0n) lines.push(`Swap ${fromUnits(ex.swapAmount, "USDC")} USDC -> at least ${fromUnits(ex.minAmountOut, "MON")} MON`);
    const deposit = ex.amountIn - ex.swapAmount;
    if (deposit > 0n) lines.push(`Deposit ${fromUnits(deposit, "USDC")} USDC into the demo vault`);
  }
  lines.push(`Spends up to ${fromUnits(plan.commit.usdcBudget, "USDC")} USDC of this week's allowance`);
  if (plan.weeklyCap !== undefined) lines.push(`Weekly cap requested: ${fromUnits(plan.weeklyCap, "USDC")} USDC`);
  lines.push(`Valid for ${Number(plan.commit.ttlSeconds) / 60} min, at most ${plan.commit.maxSignatures} signatures`);
  return lines;
}

const b64urlEncode = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** Intent <-> URL parameter for approval links handed out by agents. Decoding re-validates: links are untrusted. */
export const encodeIntentParam = (intent: Intent) => b64urlEncode(JSON.stringify(intent));
export const decodeIntentParam = (param: string): Intent => IntentSchema.parse(JSON.parse(b64urlDecode(param)));

/** JSON.stringify that keeps bigints as decimal strings. */
export const toJson = (v: unknown, space?: number) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);
