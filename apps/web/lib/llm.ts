import "server-only";
import type { LlmParser } from "@intentguard/core";

// Server-side only: API keys never reach the browser. Only the command text is sent to the model.
const SYSTEM = `You convert ONE wallet command (Italian or English) into an IntentGuard intent. Reply with JSON only.
- version is 1. Supported actions only:
  bridge: USDC from "base-sepolia" to "monad-testnet";
  swap: USDC -> MON on "monad-testnet", amount as decimal string or {"fractionOfPrevious": 0..1} of the previous action's amount;
  deposit: USDC into vault "demo-usdc" on "monad-testnet", amount as decimal string or "remaining";
  transfer: USDC or MON on "monad-testnet" or "base-sepolia" to an address.
- Amounts are decimal strings with "." (e.g. "1.5"). A weekly spending limit goes in limits.weeklyCap {token:"USDC", amount}.
- Never invent addresses or actions. If the command asks for anything else, return {"version":1,"actions":[],"rawText":""}.`;

const withoutMeta = (schema: object) => {
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  return rest;
};

function gemini(key: string, model: string): LlmParser {
  return async (text, schema) => {
    const call = (structured: boolean) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: structured ? SYSTEM : `${SYSTEM}\nJSON Schema:\n${JSON.stringify(withoutMeta(schema))}` }] },
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            ...(structured && { responseJsonSchema: withoutMeta(schema) }),
          },
        }),
      });
    let res = await call(true);
    if (res.status === 400) res = await call(false); // schema keyword not supported by this model: schema in the prompt
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text ?? "null");
  };
}

function groq(key: string, model: string): LlmParser {
  return async (text, schema) => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${SYSTEM}\nJSON Schema:\n${JSON.stringify(withoutMeta(schema))}` },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) throw new Error(`groq ${res.status}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return JSON.parse(j.choices?.[0]?.message?.content ?? "null");
  };
}

/** Provider from env (LLM_PROVIDER = gemini | groq | rules); no key means the deterministic rules parser only. */
export function llmFromEnv(env = process.env): LlmParser | undefined {
  const provider = env.LLM_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : env.GROQ_API_KEY ? "groq" : "rules");
  if (provider === "gemini" && env.GEMINI_API_KEY) return gemini(env.GEMINI_API_KEY, env.GEMINI_MODEL || "gemini-3.5-flash-lite");
  if (provider === "groq" && env.GROQ_API_KEY) return groq(env.GROQ_API_KEY, env.GROQ_MODEL || "openai/gpt-oss-20b");
  return undefined;
}
