import { parseIntent, ParseError } from "@intentguard/core";
import { llmFromEnv } from "@/lib/llm";

export const dynamic = "force-dynamic";

/** Natural language -> validated intent. LLM if configured, deterministic rules otherwise (or as fallback). */
export async function POST(req: Request) {
  const { text } = (await req.json().catch(() => ({}))) as { text?: unknown };
  if (typeof text !== "string" || !text.trim() || text.length > 600) {
    return Response.json({ error: "send { text } (max 600 characters)" }, { status: 400 });
  }
  try {
    const r = await parseIntent(text, llmFromEnv());
    return Response.json(r);
  } catch (e) {
    const code = e instanceof ParseError ? e.code : "invalid";
    return Response.json({ error: e instanceof Error ? e.message : String(e), code }, { status: 422 });
  }
}
