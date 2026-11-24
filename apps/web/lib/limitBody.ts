/** Max JSON body size for the new IntentGuard API routes (simulate, probe, counterparty). */
export const MAX_BODY_BYTES = 16 * 1024;

export async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: Response.json({ error: "payload too large" }, { status: 413 }) };
  }
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: Response.json({ error: "payload too large" }, { status: 413 }) };
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(buf)) as unknown };
  } catch {
    return { ok: false, response: Response.json({ error: "invalid JSON" }, { status: 400 }) };
  }
}
