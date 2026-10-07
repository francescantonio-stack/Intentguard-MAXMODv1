export const dynamic = "force-dynamic";

const IRIS = process.env.CIRCLE_IRIS_API_URL || "https://iris-api-sandbox.circle.com";
const ALLOWED = [/^v2\/burn\/USDC\/fees\/\d+\/\d+$/, /^v2\/messages\/\d+$/];

/** Read-only proxy to Circle's CCTP sandbox API (fees + attestations), limited to the two endpoints we use. */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOWED.some((r) => r.test(path))) return Response.json({ error: "not allowed" }, { status: 404 });
  const res = await fetch(`${IRIS}/${path}${new URL(req.url).search}`, { cache: "no-store" });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
