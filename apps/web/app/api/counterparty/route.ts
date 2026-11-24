import { createPublicClient, http, type Address } from "viem";
import { BASE_SEPOLIA, MONAD_TESTNET, checkCounterparty, toJson } from "@intentguard/core";
import { readJsonBody } from "../../../lib/limitBody";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RPC: Record<number, string> = {
  [MONAD_TESTNET.id]: process.env.MONAD_RPC_URL || MONAD_TESTNET.rpc,
  [BASE_SEPOLIA.id]: process.env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA.rpc,
};

/** POST a payee check. Read-only eth_getCode on a fixed public testnet RPC. Never signs. Body > 16KB → 413. */
export async function POST(req: Request) {
  const limited = await readJsonBody(req);
  if (!limited.ok) return limited.response;
  if (limited.body == null || typeof limited.body !== "object" || Array.isArray(limited.body)) {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const body = limited.body as Record<string, unknown>;
  const chainId = Number(body.chainId ?? MONAD_TESTNET.id);
  const url = RPC[chainId];
  if (!url) return Response.json({ error: "unsupported chainId (monad-testnet=10143, base-sepolia=84532)" }, { status: 400 });
  const client = createPublicClient({ transport: http(url) });
  const verdict = await checkCounterparty(body, {
    getCode: (a: { address: Address }) => client.getCode({ address: a.address }),
  });
  return new Response(toJson(verdict), { headers: { "content-type": "application/json" } });
}
