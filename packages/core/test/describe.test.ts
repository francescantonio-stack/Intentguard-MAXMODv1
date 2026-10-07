import { describe, expect, it } from "vitest";
import { decodeIntentParam, encodeIntentParam, summarizePlan, toJson } from "../src/describe";
import { parseRules } from "../src/parser";
import { buildPlan } from "../src/planner";

const DEMO = "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana.";

describe("plan presentation", () => {
  it("summarizes the demo plan", () => {
    const plan = buildPlan(parseRules(DEMO), {
      account: "0xd2FE6a3Ae252D6fb2f604805898177c8FdaAa24B", nonce: 0n, now: 1_790_000_000n,
      reserves: { usdc: 63_670_000n, wmon: 14_150_000_000_000_000_000n },
    });
    const lines = summarizePlan(plan);
    expect(lines[0]).toBe("1. [base-sepolia] Approve 2 USDC to CCTP");
    expect(lines).toContain("Deposit 1 USDC into the demo vault");
    expect(lines).toContain("Spends up to 2 USDC of this week's allowance");
    expect(lines.some((l) => l.startsWith("Swap 1 USDC -> at least 0.21"))).toBe(true);
    expect(toJson({ a: 1n })).toBe('{"a":"1"}');
  });

  it("round-trips intents through approval links (UTF-8 safe) and rejects tampered ones", () => {
    const intent = parseRules(DEMO);
    expect(decodeIntentParam(encodeIntentParam(intent))).toEqual(intent);
    const bad = encodeIntentParam({ ...intent, actions: [{ type: "drain" }] } as never);
    expect(() => decodeIntentParam(bad)).toThrow();
  });
});
