import { createPublicClient, http, type Address } from "viem";
import { BASE_SEPOLIA, MONAD_TESTNET, checkCounterparty, toJson } from "@intentguard/core";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RPC: Record<number, string> = {
  [MONAD_TESTNET.id]: process.env.MONAD_RPC_URL || MONAD_TESTNET.rpc,
  [BASE_SEPOLIA.id]: process.env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpc,
};

/** POST a payee check. Read-only eth_getCode on a fixed public testnet RPC. Never signs. */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const chainId = Number(body.chainId ?? MONAD_TESTNET.id);
  const url = RPC[chainId];
  if (!url) return Response.json({ error: "unsupported chainId (monad-testnet=10143, base-sepolia=84532)" }, { status: 400 });
  const client = createPublicClient({ transport: http(url) });
  const verdict = await checkCounterparty(body, {
    getCode: (a: { address: Address }) => client.getCode({ address: a.address }),
  });
  return new Response(toJson(verdict), { headers: { "content-type": "application/json" } });
}
