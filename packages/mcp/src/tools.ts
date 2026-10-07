import {
  buildPlan, encodeIntentParam, IntentSchema, toUnits, parseRules, PolicyError, ParseError, summarizePlan, toJson, type Intent,
} from "@intentguard/core";
import { ZodError } from "zod";
import {
  cctpFastMaxFee, DEFAULT_CONFIG, guardLog, planContext, PolicyClient, readState, userEvmAddress, type IntentGuardConfig,
} from "@intentguard/signer";

export type McpEnv = { cfg: IntentGuardConfig; user: string; appUrl: string };
export type ToolOutput = { ok: boolean; text: string };

export function envFromProcess(env = process.env): McpEnv {
  const user = env.NEAR_USER;
  if (!user) throw new Error("set NEAR_USER (the user's NEAR testnet account)");
  return {
    user,
    appUrl: (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    cfg: {
      nearRpc: env.NEAR_RPC_URL ?? DEFAULT_CONFIG.nearRpc,
      policy: env.POLICY_CONTRACT_ID ?? DEFAULT_CONFIG.policy,
      monadRpc: env.MONAD_RPC_URL ?? DEFAULT_CONFIG.monadRpc,
      baseRpc: env.BASE_SEPOLIA_RPC_URL ?? DEFAULT_CONFIG.baseRpc,
      irisApi: env.CIRCLE_IRIS_API_URL ?? DEFAULT_CONFIG.irisApi,
    },
  };
}

const policyOf = (e: McpEnv) => new PolicyClient(e.cfg.nearRpc, e.cfg.policy, e.user); // read-only: no key, ever
const accountOf = (e: McpEnv) => userEvmAddress(e.cfg.policy, e.user);

export async function status(e: McpEnv): Promise<ToolOutput> {
  const s = await readState(e.cfg, policyOf(e), accountOf(e));
  return { ok: true, text: toJson({ nearUser: e.user, policyContract: e.cfg.policy, evmAddress: s.account, ...s }, 2) };
}

/**
 * The only way an agent can move funds: propose. The plan is built and checked here, then a human approves
 * it with a passkey through the link. A blocked plan returns why it was blocked.
 */
export async function proposePlan(e: McpEnv, input: { command?: string; intent?: unknown }): Promise<ToolOutput> {
  try {
    let intent: Intent;
    if (input.intent !== undefined) intent = IntentSchema.parse({ rawText: input.command ?? "", ...(input.intent as object) });
    else if (input.command) intent = parseRules(input.command);
    else return { ok: false, text: "provide `command` (natural language) or `intent` (JSON matching the schema)" };

    const s = await readState(e.cfg, policyOf(e), accountOf(e));
    const bridge = intent.actions.find((a) => a.type === "bridge");
    const cctpMaxFee = bridge ? await cctpFastMaxFee(e.cfg.irisApi, toUnits(bridge.amount, "USDC")) : undefined;
    const plan = buildPlan(intent, planContext(s, { cctpMaxFee }));
    const approveUrl = `${e.appUrl}/?intent=${encodeIntentParam(intent)}`;
    return {
      ok: true,
      text: [
        "Plan accepted by IntentGuard's local checks. Nothing has been signed.",
        "Ask the user to open this link and approve it with their passkey:",
        approveUrl,
        "",
        ...summarizePlan(plan),
        "",
        `planId: ${plan.planId}`,
      ].join("\n"),
    };
  } catch (err) {
    if (err instanceof ZodError) return { ok: false, text: `invalid intent: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    if (err instanceof PolicyError || err instanceof ParseError) {
      return { ok: false, text: `BLOCKED by IntentGuard (${err.code}): ${err.message}. The NEAR policy and PlanExecutor would reject it on-chain too.` };
    }
    throw err;
  }
}

export async function recentDecisions(e: McpEnv, limit = 10): Promise<ToolOutput> {
  const log = await guardLog({ policy: e.cfg.policy, nearRpc: e.cfg.nearRpc, limit });
  const lines = log.map((x) => `${x.time ?? "?"}  ${x.ok ? "ALLOWED " : "REJECTED"}  ${x.method}  ${x.signer}${x.reason ? `  (${x.reason})` : ""}  ${x.url}`);
  return { ok: true, text: lines.join("\n") || "no recent decisions" };
}
