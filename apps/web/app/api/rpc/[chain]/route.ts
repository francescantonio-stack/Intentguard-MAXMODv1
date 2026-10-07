export const dynamic = "force-dynamic";

// Same-origin JSON-RPC passthrough to fixed public TESTNET endpoints (never mainnet, never user-supplied URLs).
const UPSTREAM: Record<string, string | undefined> = {
  near: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
  monad: process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz",
  base: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
};

export async function POST(req: Request, { params }: { params: Promise<{ chain: string }> }) {
  const upstream = UPSTREAM[(await params).chain];
  if (!upstream) return Response.json({ error: "unknown chain" }, { status: 404 });
  const body = await req.text();
  if (body.length > 256_000) return Response.json({ error: "request too large" }, { status: 413 });
  const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body, cache: "no-store" });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
