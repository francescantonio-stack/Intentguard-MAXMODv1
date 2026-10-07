import { IntentSchema, type Intent, type IntentAction } from "./schema";
import { intentJsonSchema } from "./schema";

export class ParseError extends Error {
  constructor(public readonly code: "empty" | "unsupported" | "no-action" | "invalid", message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const num = (s: string) => s.replace(",", ".");

// Anything outside the hackathon perimeter (docs/piano.md "Fuori scope") is refused, never guessed.
const UNSUPPORTED = /\b(nft|ethereum|mainnet|arbitrum|solana|polygon|optimism|zora|bitcoin|btc|eth|usdt|dai)\b/;

const CAP = new RegExp(
  String.raw`(?:non spendere pi[uù] di|non superare|al massimo|massimo|max|don'?t spend more than|no more than|at most|cap(?: of)?)\s+${NUM}\s*usdc\s*(?:a|alla|per|each|every|a\s+)?\s*(?:settimana|week)`,
);
const BRIDGE = new RegExp(
  String.raw`(?:porta|sposta|trasferisci|bridge|move|bring|transfer)\s+${NUM}\s*usdc\s+(?:da|from)\s+base(?:\s+sepolia)?\s+(?:su|a|in|verso|to|onto|into)\s+monad`,
  "g",
);
const SWAP = new RegExp(
  String.raw`(?:cambia|scambia|converti|swap|convert|exchange|trade)(?:ne)?\s+(?:(met[aà]|half)|(un quarto|a quarter|quarter)|(un terzo|a third|third)|(\d{1,3})\s*%|${NUM}\s*usdc)\s*(?:of it\s+)?(?:in|to|into|per|for)\s+mon\b`,
  "g",
);
const DEPOSIT = new RegExp(
  String.raw`(?:(?:metti|deposita|versa|deposit|put)\s+)?(?:(il resto|the rest|the remainder|remaining|tutto|everything|all)|${NUM}\s*usdc)\s+(?:nel|nella|in|into)\s+(?:the\s+|il\s+)?vault`,
  "g",
);
const TRANSFER = new RegExp(
  String.raw`(?:manda|invia|paga|send|pay)\s+${NUM}\s*(usdc|mon)\s+(?:a|ad|to)\s+([^\s,;]+)(\s+(?:su|on)\s+base)?`,
  "g",
);

/**
 * Deterministic rules parser (Italian + English). The fallback when the LLM is down or returns junk:
 * it must cover the demo command so the demo never depends on the LLM.
 */
export function parseRules(text: string): Intent {
  let t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) throw new ParseError("empty", "empty command");
  if (UNSUPPORTED.test(t)) throw new ParseError("unsupported", "only USDC/MON on Base Sepolia and Monad testnet are supported");

  let limits: Intent["limits"];
  const cap = CAP.exec(t);
  if (cap?.[1]) {
    limits = { weeklyCap: { token: "USDC", amount: num(cap[1]) } };
    t = t.replace(cap[0], " ");
  }

  const found: Array<{ at: number; action: IntentAction }> = [];
  for (const m of t.matchAll(BRIDGE)) {
    found.push({ at: m.index, action: { type: "bridge", token: "USDC", amount: num(m[1]!), from: "base-sepolia", to: "monad-testnet" } });
  }
  for (const m of t.matchAll(SWAP)) {
    const fraction = m[1] ? 0.5 : m[2] ? 0.25 : m[3] ? 1 / 3 : m[4] ? Number(m[4]) / 100 : undefined;
    if (fraction !== undefined && !(fraction > 0 && fraction <= 1)) throw new ParseError("invalid", `bad swap fraction in "${m[0]}"`);
    const amount = fraction !== undefined ? { fractionOfPrevious: fraction } : num(m[5]!);
    found.push({ at: m.index, action: { type: "swap", chain: "monad-testnet", sell: "USDC", buy: "MON", amount } });
  }
  for (const m of t.matchAll(DEPOSIT)) {
    found.push({ at: m.index, action: { type: "deposit", chain: "monad-testnet", vault: "demo-usdc", amount: m[1] ? "remaining" : num(m[2]!) } });
  }
  for (const m of t.matchAll(TRANSFER)) {
    const to = m[3]!.replace(/[.…]+$/, "");
    // Keep the original casing of the recipient (checksummed addresses).
    const original = text.match(new RegExp(to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))?.[0] ?? to;
    found.push({
      at: m.index,
      action: {
        type: "transfer",
        chain: m[4] ? "base-sepolia" : "monad-testnet",
        token: m[2]!.toUpperCase() as "USDC" | "MON",
        amount: num(m[1]!),
        to: original,
      },
    });
  }
  if (found.length === 0) throw new ParseError("no-action", "no supported action found (bridge, swap, deposit, transfer)");

  const actions = found.sort((a, b) => a.at - b.at).map((f) => f.action);
  actions.forEach((a, i) => {
    const relative = (a.type === "swap" && typeof a.amount === "object") || (a.type === "deposit" && a.amount === "remaining");
    if (relative && i === 0) throw new ParseError("invalid", `"${a.type}" refers to a previous amount, but nothing comes before it`);
  });

  return IntentSchema.parse({ version: 1, actions, limits, rawText: text });
}

/** Any LLM adapter (Gemini, Groq, …): gets the text and the JSON Schema, returns raw JSON. Runs server-side. */
export type LlmParser = (text: string, jsonSchema: typeof intentJsonSchema) => Promise<unknown>;

export type ParseResult = { intent: Intent; source: "llm" | "rules"; llmError?: string };

/**
 * LLM first, rules as fallback. LLM output is untrusted: it is schema-validated here and every amount and
 * recipient is re-checked by the planner and, on-chain, by the NEAR policy and PlanExecutor.
 */
export async function parseIntent(text: string, llm?: LlmParser): Promise<ParseResult> {
  if (llm) {
    try {
      const raw = await llm(text, intentJsonSchema);
      const intent = IntentSchema.parse({ ...(raw as object), rawText: text });
      return { intent, source: "llm" };
    } catch (e) {
      return { intent: parseRules(text), source: "rules", llmError: e instanceof Error ? e.message : String(e) };
    }
  }
  return { intent: parseRules(text), source: "rules" };
}
