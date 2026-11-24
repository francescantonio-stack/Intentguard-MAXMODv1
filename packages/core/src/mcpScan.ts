/**
 * MCP server scanner (idea from MonadGuard): checks a server's `tools/list` BEFORE the agent may use it.
 * Looks for hidden instructions in descriptions, tools with too-wide powers, and descriptions that
 * changed since they were pinned (a "rug pull"). Gives a verdict and, on BLOCK, a `blocked` QueueEvent.
 * Pure: no network, no keys, no signing. Anything malformed or unknown is blocked (fail-closed).
 * First scan = WARN NO_BASELINE: never auto-connect; save `pins`, rescan with them before use (see docs/mcp-scan.md).
 */
import { keccak256, toBytes, type Hex } from "viem";
import { blockedEvent, type QueueEvent } from "./events";

export type McpVerdict = "OK" | "WARN" | "BLOCK";
export type McpSeverity = "high" | "medium";
export type McpCode =
  | "BAD_CONFIG" | "MALFORMED" | "DUPLICATE_TOOL"
  | "HIDDEN_INSTRUCTION" | "INVISIBLE_CHARS" | "ENCODED_BLOB" | "CROSS_TOOL_REFERENCE" | "LONG_DESCRIPTION"
  | "WIDE_PERMISSION" | "DESTRUCTIVE" | "SECRET_PARAM"
  | "TOOL_CHANGED" | "TOOL_ADDED" | "TOOL_REMOVED" | "NO_BASELINE";

export interface McpFinding { code: McpCode; severity: McpSeverity; tool: string | null; detail: string }
export interface McpScanConfig {
  maxDescriptionLength: number; // above this -> LONG_DESCRIPTION (medium)
  maxBlobLength: number;        // base64/hex run at least this long -> ENCODED_BLOB (high)
}
export const MCP_SCAN_DEFAULTS: McpScanConfig = { maxDescriptionLength: 1024, maxBlobLength: 80 };

export interface McpScanInput {
  server: string;
  tools: unknown;                        // the `tools` array of a tools/list reply
  baseline?: Record<string, string>;     // tool name -> pin from an earlier scan
  config?: Partial<McpScanConfig>;
}
export interface McpScanResult {
  verdict: McpVerdict;
  findings: McpFinding[];
  pins: Record<string, Hex>;             // save these as the next baseline (only meaningful if verdict !== BLOCK)
}

const HIDDEN_SRC: RegExp[] = [
  /ignore (all |any )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /(do not|don't|never) (tell|inform|mention|show|reveal)[^.]{0,40}(user|human)/i,
  /<\s*\/?\s*(important|system|instructions?|secret|hidden)\s*>/i,
  /\b(system prompt|developer message)\b/i,
  /\byou (must|should) (now |first |always )?(call|run|use|send|read|forward)\b/i,
  /\b(before|after) (using|calling) (this|any) tool\b/i,
  /<!--[\s\S]*?-->/,
  /\b(send|forward|upload|exfiltrat\w*|post)\b[^.]{0,60}\b(to|at) (https?:\/\/|the url|this url|[\w.-]+\.\w{2,})/i,
  /~\/\.(ssh|aws|env|config)|id_rsa|\.env\b|mcp\.json/i,
];
// any whitespace (tab, newline, double space) between words still matches
const HIDDEN: RegExp[] = HIDDEN_SRC.map((re) => new RegExp(re.source.replace(/ /g, "\\s+"), re.flags));
const SECRET_WORDS = /(private.?key|secret|seed|mnemonic|password|passphrase|api.?key|access.?token|\btoken\b|credential)/i;
const WIDE_NAMES = /(^|[_\-.])(exec|execute|shell|bash|cmd|command|run_?command|eval|spawn|system|sudo|sign|transfer|withdraw|approve|delete_?all|drop|rm)([_\-.]|$)/i;
const WIDE_PARAMS = /^(command|cmd|shell|script|code|exec|path|file|filepath|url|endpoint|query|sql)$/i;
// zero-width, bidi overrides, tag characters, soft hyphen
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const ZERO_PLAN = `0x${"0".repeat(64)}`;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const finitePos = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Stable JSON (sorted keys) so the pin does not depend on key order. */
function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (isObj(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}`;
  return JSON.stringify(x ?? null);
}
/** Pin of the WHOLE tool object (title, outputSchema, _meta and any other field included). */
export function pinTool(tool: unknown): Hex {
  return keccak256(toBytes(canon(tool)));
}

// Basic confusables (Cyrillic/Greek look-alikes) -> Latin, applied after NFKC (which folds fullwidth).
const HOMO: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ɡ": "g",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t", "ι": "i", "κ": "k", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
export function normalizeText(x: string): string {
  return x.normalize("NFKC").replace(/./gu, (c) => HOMO[c] ?? c);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Decode a base64 run; returns text only if it is mostly printable, else null. */
function decodeB64(run: string): string | null {
  const clean = run.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let bits = 0, acc = 0, out = "";
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
  }
  if (out.length < 8) return null;
  const printable = [...out].filter((c) => c >= " " && c <= "~").length;
  return printable / out.length >= 0.9 ? out : null;
}

/** All strings found inside the schema (property names, descriptions, enums, defaults). */
function allTexts(x: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) { out.push("\u0000DEPTH"); return out; }
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => allTexts(v, out, depth + 1));
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) { out.push(k); allTexts(v, out, depth + 1); }
  return out;
}
function paramNames(schema: unknown): string[] {
  return isObj(schema) && isObj(schema.properties) ? Object.keys(schema.properties) : [];
}

export function scanMcpTools(input: McpScanInput): McpScanResult {
  const findings: McpFinding[] = [];
  const pins: Record<string, Hex> = {};
  const add = (code: McpCode, severity: McpSeverity, tool: string | null, detail: string) => findings.push({ code, severity, tool, detail });
  const done = (): McpScanResult => ({
    verdict: findings.some((f) => f.severity === "high") ? "BLOCK" : findings.length ? "WARN" : "OK",
    findings,
    pins,
  });

  if (!isObj(input)) { add("MALFORMED", "high", null, "input is not an object"); return done(); }
  const rawCfg = input.config === undefined ? {} : input.config;
  if (!isObj(rawCfg)) { add("BAD_CONFIG", "high", null, "config is not an object"); return done(); }
  const cfg: McpScanConfig = { ...MCP_SCAN_DEFAULTS, ...rawCfg };
  for (const k of Object.keys(MCP_SCAN_DEFAULTS) as Array<keyof McpScanConfig>) {
    if (!finitePos(cfg[k])) { add("BAD_CONFIG", "high", null, `config.${k} must be finite and > 0`); return done(); }
  }
  if (input.baseline !== undefined && (!isObj(input.baseline) || !Object.values(input.baseline).every((v) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v)))) {
    add("BAD_CONFIG", "high", null, "baseline must map tool names to 32-byte hex pins"); return done();
  }
  if (typeof input.server !== "string" || !input.server.trim()) { add("MALFORMED", "high", null, "server name missing"); return done(); }
  if (!Array.isArray(input.tools)) { add("MALFORMED", "high", null, "tools is not a list"); return done(); }

  const blobRe = new RegExp(`[A-Za-z0-9+/=_-]{${Math.floor(cfg.maxBlobLength)},}`);
  const names = new Set<string>();
  const allNames = input.tools.map((t) => (isObj(t) && typeof t.name === "string" ? t.name : "")).filter(Boolean);

  for (const t of input.tools) {
    if (!isObj(t) || typeof t.name !== "string" || !t.name.trim()) { add("MALFORMED", "high", null, "tool without a name"); continue; }
    const name = t.name;
    if (t.description !== undefined && typeof t.description !== "string") { add("MALFORMED", "high", name, "description is not text"); continue; }
    if (t.inputSchema !== undefined && !isObj(t.inputSchema)) { add("MALFORMED", "high", name, "inputSchema is not an object"); continue; }
    if (names.has(name)) { add("DUPLICATE_TOOL", "high", name, "same tool name twice (shadowing)"); continue; }
    names.add(name);
    try { pins[name] = pinTool(t); } catch { add("MALFORMED", "high", name, "tool is not plain JSON"); continue; }

    const desc = (t.description as string | undefined) ?? "";
    // scan EVERY field of the tool (title, outputSchema, _meta, ...), not only the known ones
    const texts = allTexts(t);
    if (texts.includes("\u0000DEPTH")) add("MALFORMED", "high", name, "schema nested too deep");
    const joined = texts.join("\n");
    const norm = normalizeText(joined);
    // short base64 runs (below maxBlobLength) are decoded and scanned too
    const decoded = [...norm.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)].map((m) => decodeB64(m[0])).filter((d): d is string => d !== null);

    const hit = HIDDEN.find((re) => re.test(norm));
    const hitB64 = hit ? undefined : HIDDEN.find((re) => decoded.some((d) => re.test(normalizeText(d))));
    if (hit) add("HIDDEN_INSTRUCTION", "high", name, `matches ${hit.source.slice(0, 40)}`);
    else if (hitB64) add("HIDDEN_INSTRUCTION", "high", name, `inside base64: ${hitB64.source.slice(0, 40)}`);
    if (INVISIBLE.test(joined)) add("INVISIBLE_CHARS", "high", name, "invisible or bidi characters in text");
    if (blobRe.test(joined)) add("ENCODED_BLOB", "high", name, "long encoded string in text");
    const other = allNames.find((o) => o !== name && o.length >= 4 && new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(joined));
    if (other) add("CROSS_TOOL_REFERENCE", "medium", name, `description mentions tool ${other}`);
    if (desc.length > cfg.maxDescriptionLength) add("LONG_DESCRIPTION", "medium", name, `${desc.length} chars`);

    const params = paramNames(t.inputSchema);
    const snake = normalizeText(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
    if (WIDE_NAMES.test(snake)) add("WIDE_PERMISSION", "high", name, "tool name suggests shell, signing or fund movement");
    const wideParam = params.find((p) => WIDE_PARAMS.test(p));
    if (wideParam) add("WIDE_PERMISSION", "medium", name, `free-form parameter "${wideParam}"`);
    const secretParam = params.find((p) => SECRET_WORDS.test(p));
    if (secretParam) add("SECRET_PARAM", "high", name, `asks for a secret ("${secretParam}")`);
    const ann = isObj(t.annotations) ? t.annotations : {};
    if (ann.destructiveHint === true && ann.readOnlyHint !== true) add("DESTRUCTIVE", "medium", name, "declares destructiveHint");
  }

  if (input.baseline === undefined) {
    add("NO_BASELINE", "medium", null, "first scan: changes cannot be detected, save `pins`");
  } else {
    const base = input.baseline;
    for (const [n, p] of Object.entries(pins)) {
      const old = base[n];
      if (old === undefined) add("TOOL_ADDED", "medium", n, "new tool since last scan");
      else if (old.toLowerCase() !== p) add("TOOL_CHANGED", "high", n, "description or schema changed since it was pinned");
    }
    for (const n of Object.keys(base)) if (!(n in pins) && !names.has(n)) add("TOOL_REMOVED", "medium", n, "tool gone since last scan");
  }
  return done();
}

/** `blocked` QueueEvent for a BLOCK verdict, null otherwise. reason = "McpScan:<codes>". */
export function mcpBlockedEvent(r: McpScanResult, planId: string, amount: bigint, ts?: string | number, server?: string): QueueEvent | null {
  if (r.verdict !== "BLOCK") return null;
  const codes = [...new Set(r.findings.filter((f) => f.severity === "high").map((f) => f.code))];
  return blockedEvent({
    planId: typeof planId === "string" ? planId : ZERO_PLAN,
    reason: `McpScan:${codes.join(",")}`,
    amount: typeof amount === "bigint" ? amount : 0n,
    ts,
    id: typeof server === "string" && server ? server : null,
  });
}
