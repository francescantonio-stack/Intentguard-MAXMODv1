import { createPublicClient, http, type Hex } from "viem";
import { BASE_SEPOLIA, MONAD_TESTNET, checkSimulateApiInput, simulateTx, toActionBlocked, toJson, toSafeHoldInput, toSuccessOddsInput } from "@intentguard/core";
import { readJsonBody } from "../../../lib/limitBody";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Fixed public TESTNET RPCs only — never a user-supplied URL, never mainnet. */
const RPC: Record<number, { url: string; label: string }> = {
  [MONAD_TESTNET.id]: { url: process.env.MONAD_RPC_URL || MONAD_TESTNET.rpc, label: MONAD_TESTNET.rpc },
  [BASE_SEPOLIA.id]: { url: process.env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpc, label: BASE_SEPOLIA.rpc },
};

/**
 * POST a proposed tx; returns the simulated effect (no signing, no broadcast).
 * Body: { chainId, from, to, data?, value?, planId? }
 * Invalid data/value → 400; body over 16KB → 413; missing planId on a failed sim → 400 MissingPlanId.
 */
export async function POST(req: Request) {
  const limited = await readJsonBody(req);
  if (!limited.ok) return limited.response;

  const parsed = checkSimulateApiInput(limited.body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });

  const rpc = RPC[parsed.tx.chainId];
  if (!rpc) return Response.json({ error: "unsupported chainId (monad-testnet=10143, base-sepolia=84532)" }, { status: 400 });

  const client = createPublicClient({ transport: http(rpc.url) });
  try {
    const sim = await simulateTx(parsed.tx, client, { rpcLabel: rpc.label });
    const blocked = toActionBlocked(sim, parsed.planId);
    if (parsed.planIdMissing && blocked) {
      return Response.json({ error: "MissingPlanId", sim, actionBlocked: blocked }, { status: 400 });
    }
    return new Response(toJson({
      sim,
      actionBlocked: blocked,
      successOddsInput: toSuccessOddsInput(sim),
      safeHoldInput: toSafeHoldInput(sim, typeof (limited.body as { intent?: unknown }).intent === "string" ? (limited.body as { intent: string }).intent : undefined),
    }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
