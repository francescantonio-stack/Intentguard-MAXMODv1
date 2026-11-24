/**
 * MCP server scanner (idea from MonadGuard): checks a server's `tools/list` BEFORE the agent may use it.
 * Looks for hidden instructions in descriptions, tools with too-wide powers, and descriptions that
 * changed since they were pinned (a "rug pull"). Gives a verdict and, on BLOCK, a `blocked` QueueEvent.
 * Pure: no network, no keys, no signing. Anything malformed or unknown is blocked (fail-closed).
 * The phrase filter is heuristic and never complete: the real protection is the pin + TOOL_CHANGED (any change, rename included, blocks).
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
  /<!--/, // any comment opener (closed or not) hides text; linear, no backtracking on many unclosed `<!--`
  /\b(send|forward|upload|exfiltrat\w*|post)\b[^.]{0,60}\b(to|at) (https?:\/\/|the url|this url|[\w.-]+\.\w{2,})/i,
  /~\/\.(ssh|aws|env|config)|id_rsa|\.env\b|mcp\.json/i,
  // Italian
  /ignora (tutte )?(le )?(istruzioni|regole|indicazioni) (precedenti|di prima|sopra|ricevute)/i,
  /non (dirlo|dirle|dirgli|dire|mostrare|rivelare|comunicare|menzionare)[^.]{0,40}(utente|umano)/i,
  // Spanish
  /ignora (todas )?(las )?(instrucciones|reglas|indicaciones) (anteriores|previas)/i,
  /no (le |les )?(digas|cuentes|muestres|reveles|informes|menciones)[^.]{0,40}(usuario|humano)/i,
  // French, German (accents are stripped by the normalization)
  /ignorez? (toutes )?les (instructions|consignes|regles) (precedentes|anterieures)/i,
  /ignoriere (alle )?(vorherigen|bisherigen|obigen) (anweisungen|instruktionen|regeln)/i,
];
// Chinese (simplified and traditional): tested on the text with ALL whitespace removed, so no \s between characters is needed
const HIDDEN_CJK: RegExp[] = [
  /忽略(之前|以前|先前|上面|前面|上述|所有|全部)*的?(所有|全部)?(指示|指令|说明|說明|规则|規則|提示)/,
  /(不要|别|別|切勿|勿)(告诉|告訴|通知|透露|显示|顯示|提及|让|讓)[^。]{0,20}(用户|用戶|使用者|人类|人類)/,
];
// any whitespace (tab, newline, double space) between words still matches
const HIDDEN: RegExp[] = HIDDEN_SRC.map((re) => new RegExp(re.source.replace(/ /g, "\\s+"), re.flags));
const SECRET_WORDS = /(private.?key|secret|seed|mnemonic|password|passphrase|api.?key|access.?token|\btoken\b|credential)/i;
const WIDE_NAMES = /(^|[_\-.])(exec|execute|shell|bash|cmd|command|run_?command|eval|spawn|system|sudo|sign|transfer|withdraw|approve|delete_?all|drop|rm)([_\-.]|$)/i;
const WIDE_PARAMS = /^(command|cmd|shell|script|code|exec|path|file|filepath|url|endpoint|query|sql)$/i;
// zero-width, bidi overrides, tag characters, soft hyphen, combining grapheme joiner, Hangul/Mongolian fillers,
// deprecated format chars (U+206A-206F), variation selectors
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/u;
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

// Confusables -> Latin, applied after NFKD (which already folds fullwidth, math letters, ligatures and accents).
const HOMO: Record<string, string> = {
  // Cyrillic (incl. extended)
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w",
  "ү": "y", "ѵ": "v", "ҽ": "e", "ɡ": "g", "в": "b", "к": "k", "м": "m", "н": "h", "т": "t", "ь": "b", "п": "n", "г": "r",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "Ԛ": "Q", "Ԝ": "W", "Ү": "Y", "Ѵ": "V", "Ӏ": "I", "Ԁ": "D", "Һ": "H",
  // Greek (incl. lunate forms)
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t", "ι": "i", "κ": "k", "ϲ": "c", "ς": "c", "ϳ": "j", "υ": "u", "ω": "w", "γ": "y", "η": "n", "ε": "e", "χ": "x", "μ": "u",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "Ϲ": "C", "Ϳ": "J",
  // Armenian
  "օ": "o", "ս": "u", "ց": "g", "հ": "h", "ո": "n", "զ": "q", "ա": "w", "ք": "p", "ե": "e", "ւ": "l", "Օ": "O", "Ս": "U", "Լ": "L", "Տ": "S", "Ձ": "Q",
  // Cherokee (capitals; small letters are upper-cased first)
  "Ꭺ": "A", "Ᏼ": "B", "Ꮯ": "C", "Ꭰ": "D", "Ꭼ": "E", "Ꮐ": "G", "Ꮋ": "H", "Ꭵ": "i", "Ꭻ": "J", "Ꮶ": "K", "Ꮮ": "L", "Ꮇ": "M", "Ꮑ": "h", "Ꮎ": "O", "Ꮲ": "P",
  "Ꮢ": "R", "Ꮪ": "S", "Ꭲ": "T", "Ꮩ": "V", "Ꮃ": "W", "Ꮖ": "I", "Ꮓ": "Z", "Ꮍ": "y",
  // Latin small capitals and other look-alikes
  "ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o",
  "ᴘ": "p", "ʀ": "r", "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z", "ı": "i", "ɩ": "i", "ɑ": "a", "ȷ": "j", "ɒ": "a", "ʋ": "u",
};
// unusual "spaces" that are letters or format chars (Hangul fillers, Mongolian separator, ...) -> plain space
const ODD_SPACE = /[\u115F\u1160\u3164\uFFA0\u180E\u2000-\u200A\u202F\u205F\u3000\u00A0\u1680]/gu;
const isCherokeeSmall = (c: string) => /[\uAB70-\uABBF\u13F8-\u13FD]/u.test(c);
/**
 * Single normalization for every check: NFKD, unusual spaces -> space, drop combining marks (\p{M}) and
 * format chars (\p{Cf}), then fold look-alikes to Latin.
 */
export function normalizeText(x: string): string {
  return x
    .normalize("NFKD")
    .replace(ODD_SPACE, " ")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(/[^\x00-\x7F]/gu, (c) => HOMO[c] ?? (isCherokeeSmall(c) ? HOMO[c.toUpperCase()] ?? c : c));
}
/** Tool name key for duplicates and baseline matching: normalized, trimmed, lowercase. */
export function normalizeToolName(n: string): string {
  return normalizeText(n).trim().toLowerCase();
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Decode a base64 run as UTF-8 (non-ASCII text such as Chinese included); text only if mostly printable, else null. */
function decodeB64(run: string): string | null {
  const clean = run.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let bits = 0, acc = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  return bytesToText(bytes);
}

// printable = letters, digits, punctuation, symbols, marks, spaces (any script), tab/newline
const PRINTABLE = /[\p{L}\p{N}\p{P}\p{S}\p{M}\p{Zs}\t\n\r]/u;
const printableRatio = (t: string) => {
  const cs = [...t];
  return cs.length ? cs.filter((c) => PRINTABLE.test(c)).length / cs.length : 0;
};
function bytesToText(bytes: number[]): string | null {
  if (bytes.length < 8) return null;
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return printableRatio(t) >= 0.9 ? t : null;
  } catch {
    // not UTF-8: accept only (almost) printable ASCII
    const ascii = bytes.filter((b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x09).length;
    return ascii / bytes.length >= 0.9 ? String.fromCharCode(...bytes.slice(0, 65536)) : null;
  }
}
const ROT13 = (t: string) => t.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c <= "Z" ? 65 : 97)));

const DECODE_MAX_DEPTH = 3;
const DECODE_MAX_VARIANTS = 64;
const DECODE_MAX_CHARS = 262_144;
/**
 * Decoded variants of a text: %xx runs, hex runs (also \xNN), base64 runs (recursive up to DECODE_MAX_DEPTH levels;
 * a result at the limit that is still decodable = overflow),
 * (rot13 is checked by the caller on the text and on each variant). Bounded by count and total size; `overflow` = budget hit (caller blocks, fail-closed).
 */
/** rot13 of a text (its own inverse). */
export const rot13 = ROT13;
/** One decoding step: every result of decoding the %xx, \\xNN, hex and base64 runs of `t`. */
function decodeOnce(t: string): string[] {
  const out: string[] = [];
  const add = (x: string | null) => { if (x !== null && x !== t) out.push(x); };
  if (/%[0-9a-f]{2}/i.test(t)) {
    add(t.replace(/(?:%[0-9a-f]{2})+/gi, (run) => bytesToText(run.slice(1).split("%").map((h) => parseInt(h, 16))) ?? run));
  }
  for (const m of t.matchAll(/(?:\\x[0-9a-f]{2}){8,}/gi)) add(bytesToText(m[0].slice(2).split(/\\x/i).map((h) => parseInt(h, 16))));
  for (const m of t.matchAll(/(?:[0-9a-f]{2}){8,}/gi)) add(bytesToText(m[0].match(/../g)!.map((h) => parseInt(h, 16))));
  for (const m of t.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) add(decodeB64(m[0]));
  return out;
}

export function decodeVariants(text: string): { variants: string[]; overflow: boolean } {
  const variants: string[] = [];
  let total = 0, overflow = false;
  const seen = new Set<string>([text]);
  const queue: Array<[string, number]> = [[text, 0]];
  while (queue.length && !overflow) {
    const [t, d] = queue.shift()!;
    const next = decodeOnce(t).filter((x) => !seen.has(x));
    if (!next.length) continue;
    // at the depth limit something is STILL decodable: deeper nesting cannot be verified -> overflow (fail-closed)
    if (d >= DECODE_MAX_DEPTH) { overflow = true; break; }
    for (const x of next) {
      if (variants.length >= DECODE_MAX_VARIANTS || total + x.length > DECODE_MAX_CHARS) { overflow = true; break; }
      seen.add(x); variants.push(x); total += x.length;
      queue.push([x, d + 1]);
    }
  }
  return { variants, overflow };
}

/** All strings found inside the schema (property names, descriptions, enums, defaults). */
function allTexts(x: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) { out.push("\u0000DEPTH"); return out; }
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => allTexts(v, out, depth + 1));
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) { out.push(k); allTexts(v, out, depth + 1); }
  return out;
}

const SCHEMA_MAX_DEPTH = 32;
const SUB_ONE = ["items", "additionalProperties", "additionalItems", "unevaluatedProperties", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames"];
const SUB_LIST = ["items", "prefixItems", "anyOf", "oneOf", "allOf"];
const SUB_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
/**
 * Parameter names at ANY depth of the schema: properties, patternProperties, items (object or list), prefixItems,
 * anyOf/oneOf/allOf, $defs/definitions, additionalProperties, not/if/then/else. Cycle-safe; too deep -> tooDeep.
 */
export function paramNames(schema: unknown): { names: string[]; tooDeep: boolean } {
  const names: string[] = [];
  const seen = new Set<object>();
  let tooDeep = false;
  const walk = (n: unknown, depth: number): void => {
    if (tooDeep || !isObj(n)) return;
    if (depth > SCHEMA_MAX_DEPTH) { tooDeep = true; return; }
    if (seen.has(n)) return;
    seen.add(n);
    for (const k of SUB_MAP) {
      const m = n[k];
      if (isObj(m)) for (const [name, sub] of Object.entries(m)) { if (k === "properties" || k === "patternProperties") names.push(name); walk(sub, depth + 1); }
    }
    for (const k of SUB_LIST) { const l = n[k]; if (Array.isArray(l)) for (const sub of l) walk(sub, depth + 1); }
    for (const k of SUB_ONE) walk(n[k], depth + 1);
  };
  walk(schema, 0);
  return { names, tooDeep };
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
  const names = new Set<string>(); // normalized names (dedupe: Get_balance, get_bаlance = get_balance)
  const allNames = input.tools.map((t) => (isObj(t) && typeof t.name === "string" ? t.name : "")).filter(Boolean);

  for (const t of input.tools) {
    if (!isObj(t) || typeof t.name !== "string" || !t.name.trim()) { add("MALFORMED", "high", null, "tool without a name"); continue; }
    const name = t.name;
    const key = normalizeToolName(name);
    if (t.description !== undefined && typeof t.description !== "string") { add("MALFORMED", "high", name, "description is not text"); continue; }
    if (t.inputSchema !== undefined && !isObj(t.inputSchema)) { add("MALFORMED", "high", name, "inputSchema is not an object"); continue; }
    if (names.has(key)) { add("DUPLICATE_TOOL", "high", name, "same tool name twice after normalization (shadowing)"); continue; }
    names.add(key);
    try { pins[name] = pinTool(t); } catch { add("MALFORMED", "high", name, "tool is not plain JSON"); continue; }

    const desc = (t.description as string | undefined) ?? "";
    // scan EVERY field of the tool (title, outputSchema, _meta, ...), not only the known ones
    const texts = allTexts(t);
    if (texts.includes("\u0000DEPTH")) add("MALFORMED", "high", name, "schema nested too deep");
    const joined = texts.join("\n");
    const norm = normalizeText(joined);
    const hiddenIn = (txt: string): RegExp | undefined => {
      const squashed = txt.replace(/\s+/g, "");
      return HIDDEN.find((re) => re.test(txt)) ?? HIDDEN_CJK.find((re) => re.test(squashed));
    };
    const hit = hiddenIn(norm);
    const hitRot = hit ? undefined : hiddenIn(ROT13(norm));
    if (hit) add("HIDDEN_INSTRUCTION", "high", name, `matches ${hit.source.slice(0, 40)}`);
    else if (hitRot) add("HIDDEN_INSTRUCTION", "high", name, `inside rot13 text: ${hitRot.source.slice(0, 40)}`);
    else {
      // encoded text (%xx, hex, base64 up to 3 levels, rot13) is decoded and scanned again
      const { variants, overflow } = decodeVariants(norm);
      let hitEnc: RegExp | undefined;
      for (const v of variants) { const nv = normalizeText(v); hitEnc = hiddenIn(nv) ?? hiddenIn(ROT13(nv)); if (hitEnc) break; }
      if (hitEnc) add("HIDDEN_INSTRUCTION", "high", name, `inside encoded text (base64/hex/%xx/rot13): ${hitEnc.source.slice(0, 40)}`);
      else if (overflow) add("ENCODED_BLOB", "high", name, "too much encoded content to verify");
    }
    if (INVISIBLE.test(joined)) add("INVISIBLE_CHARS", "high", name, "invisible or bidi characters in text");
    if (blobRe.test(joined)) add("ENCODED_BLOB", "high", name, "long encoded string in text");
    const other = allNames.find((o) => o !== name && o.length >= 4 && new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(joined));
    if (other) add("CROSS_TOOL_REFERENCE", "medium", name, `description mentions tool ${other}`);
    if (desc.length > cfg.maxDescriptionLength) add("LONG_DESCRIPTION", "medium", name, `${desc.length} chars`);

    const { names: params, tooDeep } = paramNames(t.inputSchema);
    if (tooDeep) add("MALFORMED", "high", name, `inputSchema nested deeper than ${SCHEMA_MAX_DEPTH}`);
    const snake = normalizeText(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
    if (WIDE_NAMES.test(snake)) add("WIDE_PERMISSION", "high", name, "tool name suggests shell, signing or fund movement");
    const wideParam = params.find((p) => WIDE_PARAMS.test(normalizeText(p)));
    if (wideParam) add("WIDE_PERMISSION", "medium", name, `free-form parameter "${wideParam}"`);
    const secretParam = params.find((p) => SECRET_WORDS.test(normalizeText(p)));
    if (secretParam) add("SECRET_PARAM", "high", name, `asks for a secret ("${secretParam}")`);
    const ann = isObj(t.annotations) ? t.annotations : {};
    if (ann.destructiveHint === true && ann.readOnlyHint !== true) add("DESTRUCTIVE", "medium", name, "declares destructiveHint");
  }

  if (input.baseline === undefined) {
    add("NO_BASELINE", "medium", null, "first scan: changes cannot be detected, save `pins`");
  } else {
    const base = input.baseline;
    // baseline matched on the NORMALIZED name: a look-alike rename (get_prіce) is the same tool, and its pin differs
    const baseByKey = new Map<string, string>();
    for (const n of Object.keys(base)) if (!baseByKey.has(normalizeToolName(n))) baseByKey.set(normalizeToolName(n), n);
    const matched = new Set<string>();
    const added: string[] = [];
    for (const [n, p] of Object.entries(pins)) {
      const bn = base[n] !== undefined ? n : baseByKey.get(normalizeToolName(n));
      if (bn === undefined) { added.push(n); add("TOOL_ADDED", "medium", n, "new tool since last scan"); continue; }
      matched.add(bn);
      if (bn !== n) add("TOOL_CHANGED", "high", n, `renamed from ${bn} (same name after normalization)`);
      else if (base[bn]!.toLowerCase() !== p) add("TOOL_CHANGED", "high", n, "description or schema changed since it was pinned");
    }
    const removed = Object.keys(base).filter((n) => !matched.has(n) && !names.has(normalizeToolName(n)));
    for (const n of removed) add("TOOL_REMOVED", "medium", n, "tool gone since last scan");
    // one tool gone and one new in the same scan = possible rename: treated as a change (BLOCK)
    if (removed.length && added.length) {
      add("TOOL_CHANGED", "high", added[0]!, `possible rename: removed ${removed.join(", ")}; added ${added.join(", ")}`);
    }
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
