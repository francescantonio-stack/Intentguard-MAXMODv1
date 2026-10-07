import { z } from "zod";

// Intent schema v1 (docs/CLAUDE.md §7). Amounts are decimal strings; bigint conversion happens only in the planner.
const Amount = z.string().regex(/^\d+(\.\d+)?$/, "decimal string, e.g. \"1.5\"");
const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte address");

export const BridgeAction = z.object({
  type: z.literal("bridge"),
  token: z.literal("USDC"),
  amount: Amount,
  from: z.literal("base-sepolia"),
  to: z.literal("monad-testnet"),
});

export const SwapAction = z.object({
  type: z.literal("swap"),
  chain: z.literal("monad-testnet"),
  sell: z.literal("USDC"),
  buy: z.literal("MON"),
  amount: z.union([Amount, z.object({ fractionOfPrevious: z.number().gt(0).lte(1) })]),
});

export const DepositAction = z.object({
  type: z.literal("deposit"),
  chain: z.literal("monad-testnet"),
  vault: z.literal("demo-usdc"),
  amount: z.union([Amount, z.literal("remaining")]),
});

export const TransferAction = z.object({
  type: z.literal("transfer"),
  chain: z.enum(["monad-testnet", "base-sepolia"]),
  token: z.enum(["USDC", "MON"]),
  amount: Amount,
  // Kept loose so a malformed recipient still reaches the policy check and gets a readable rejection.
  to: z.string().min(1),
});

export const Action = z.discriminatedUnion("type", [BridgeAction, SwapAction, DepositAction, TransferAction]);

export const IntentSchema = z.object({
  version: z.literal(1),
  actions: z.array(Action).min(1),
  limits: z.object({ weeklyCap: z.object({ token: z.literal("USDC"), amount: Amount }).optional() }).optional(),
  rawText: z.string(),
});

export type Intent = z.infer<typeof IntentSchema>;
export type IntentAction = z.infer<typeof Action>;
export { EvmAddress };

/** JSON Schema handed to the LLM for structured output. */
export const intentJsonSchema = z.toJSONSchema(IntentSchema);
