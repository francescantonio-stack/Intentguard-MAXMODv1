import { DEFAULT_CONFIG, guardLog } from "@intentguard/signer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Latest decisions of the policy contract (public data: nearblocks testnet + NEAR RPC). */
export async function GET() {
  try {
    const entries = await guardLog({
      policy: process.env.NEXT_PUBLIC_POLICY_CONTRACT_ID || DEFAULT_CONFIG.policy,
      nearRpc: process.env.NEAR_RPC_URL || DEFAULT_CONFIG.nearRpc,
      limit: 20,
    });
    return Response.json({ entries });
  } catch (e) {
    return Response.json({ entries: [], error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
