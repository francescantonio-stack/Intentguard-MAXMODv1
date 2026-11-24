import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { BASE_SEPOLIA, MONAD_TESTNET, simulateTx, toActionBlocked, toJson, toSafeHoldInput, toSuccessOddsInput } from "@intentguard/core";

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
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  const chainId = Number(body.chainId);
  const rpc = RPC[chainId];
  if (!rpc) return Response.json({ error: "unsupported chainId (monad-testnet=10143, base-sepolia=84532)" }, { status: 400 });
  if (typeof body.from !== "string" || !isAddress(body.from) || typeof body.to !== "string" || !isAddress(body.to)) {
    return Response.json({ error: "from and to must be 0x addresses" }, { status: 400 });
  }
  const value = body.value === undefined || body.value === "" ? 0n : BigInt(String(body.value));
  const data = (typeof body.data === "string" && body.data.startsWith("0x") ? body.data : "0x") as Hex;
  const client = createPublicClient({ transport: http(rpc.url) });
  try {
    const sim = await simulateTx(
      { chainId, from: body.from as Address, to: body.to as Address, data, value },
      client,
      { rpcLabel: rpc.label },
    );
    const planId = typeof body.planId === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.planId) ? (body.planId as Hex) : undefined;
    const blocked = planId ? toActionBlocked(sim, planId) : null;
    return new Response(toJson({
      sim,
      actionBlocked: blocked,
      successOddsInput: toSuccessOddsInput(sim),
      safeHoldInput: toSafeHoldInput(sim, typeof body.intent === "string" ? body.intent : undefined),
    }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
