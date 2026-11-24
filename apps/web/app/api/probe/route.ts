import { probeNetworks, toJson } from "@intentguard/core";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Read-only probe of the public testnets (Monad, Base Sepolia, NEAR). */
export async function GET() {
  try {
    const networks = await probeNetworks();
    return new Response(toJson({ networks }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
