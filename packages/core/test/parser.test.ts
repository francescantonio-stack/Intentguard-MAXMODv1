import { describe, expect, it } from "vitest";
import { parseIntent, parseRules, ParseError } from "../src/parser";

const DEMO = "Porta 2 USDC da Base su Monad, cambiane metà in MON e metti il resto nel vault. Non spendere più di 5 USDC a settimana.";

const bridge = (amount: string) => ({ type: "bridge", token: "USDC", amount, from: "base-sepolia", to: "monad-testnet" });
const swap = (amount: unknown) => ({ type: "swap", chain: "monad-testnet", sell: "USDC", buy: "MON", amount });
const deposit = (amount: string) => ({ type: "deposit", chain: "monad-testnet", vault: "demo-usdc", amount });
const cap = (amount: string) => ({ weeklyCap: { token: "USDC", amount } });

describe("parseRules: demo command + 9 more (M3)", () => {
  const cases: Array<[string, unknown[], unknown?]> = [
    [DEMO, [bridge("2"), swap({ fractionOfPrevious: 0.5 }), deposit("remaining")], cap("5")],
    ["Bridge 3 USDC from Base to Monad", [bridge("3")]],
    ["Cambia 1 USDC in MON", [swap("1")]],
    ["Metti 1,5 USDC nel vault", [deposit("1.5")]],
    ["Porta 2 USDC da Base su Monad, cambiane un quarto in MON, il resto nel vault", [bridge("2"), swap({ fractionOfPrevious: 0.25 }), deposit("remaining")]],
    ["Swap 0.5 USDC to MON and deposit 0.5 USDC into the vault", [swap("0.5"), deposit("0.5")]],
    ["Bridge 2 USDC from Base Sepolia to Monad, swap 30% to MON, put the rest in the vault. Don't spend more than 4 USDC a week",
      [bridge("2"), swap({ fractionOfPrevious: 0.3 }), deposit("remaining")], cap("4")],
    ["Porta 10 USDC da Base su Monad e metti tutto nel vault. Max 5 USDC a settimana", [bridge("10"), deposit("remaining")], cap("5")],
  ];
  it.each(cases)("%s", (text, actions, limits) => {
    const intent = parseRules(text);
    expect(intent.actions).toEqual(actions);
    expect(intent.limits).toEqual(limits);
    expect(intent.rawText).toBe(text);
  });

  it("negative demo: keeps the (bad) recipient so the planner can reject it", () => {
    const intent = parseRules("Manda 50 USDC a 0xabc…");
    expect(intent.actions).toEqual([{ type: "transfer", chain: "monad-testnet", token: "USDC", amount: "50", to: "0xabc" }]);
  });

  it("keeps the checksum casing of a full recipient address", () => {
    const to = "0xD22418AF35295B515F00eBfcFE8a42bBeF446300";
    expect(parseRules(`Send 1 USDC to ${to} on Base`).actions[0]).toMatchObject({ chain: "base-sepolia", to });
  });

  it.each([
    ["Compra un NFT su Zora", "unsupported"],
    ["Porta 2 USDC da Ethereum su Monad", "unsupported"],
    ["ciao come stai", "no-action"],
    ["   ", "empty"],
    ["Cambiane metà in MON", "invalid"],
  ])("rejects %s (%s)", (text, code) => {
    expect(() => parseRules(text)).toThrow(ParseError);
    try { parseRules(text); } catch (e) { expect((e as ParseError).code).toBe(code); }
  });
});

describe("parseIntent", () => {
  it("uses the LLM output when it validates", async () => {
    const llm = async () => ({ version: 1, actions: [bridge("2")] });
    const r = await parseIntent("whatever", llm);
    expect(r.source).toBe("llm");
    expect(r.intent.rawText).toBe("whatever");
  });

  it("falls back to rules when the LLM fails or returns junk", async () => {
    for (const llm of [async () => { throw new Error("429"); }, async () => ({ version: 1, actions: [{ type: "drain" }] })]) {
      const r = await parseIntent(DEMO, llm);
      expect(r.source).toBe("rules");
      expect(r.llmError).toBeTruthy();
      expect(r.intent.actions).toHaveLength(3);
    }
  });

  it("works with no LLM configured (acceptance test 6)", async () => {
    expect((await parseIntent(DEMO)).source).toBe("rules");
  });
});
