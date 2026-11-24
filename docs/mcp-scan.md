# MCP scanner (`packages/core/src/mcpScan.ts`)

Checks the `tools/list` reply of an MCP server **before** the agent may use it. Pure function: no network, no keys.

## How to use it (important)

1. **First scan** of a server has no pins, so it returns `WARN` with `NO_BASELINE`.
   The caller must **not** connect automatically: show the findings, save `result.pins`
   (only if the verdict is not `BLOCK`), then call `tools/list` again and scan with `baseline: pins` before first use.
2. **Every later use**: call `tools/list` again and scan with the saved `baseline`.
   Any changed tool (description, schema, title, outputSchema, `_meta`, any field) gives `BLOCK` with `TOOL_CHANGED`.
3. On `BLOCK`, emit `mcpBlockedEvent(result, planId, amount, ts, server)` (reason `McpScan:<codes>`) and do not call the server.
4. `WARN` (free-form params, destructiveHint, tools added or removed, cross-tool mentions, long text) needs a human look.

## What is checked

- Every string in the whole tool object, after ONE normalization (NFKD, unusual spaces such as U+3164 -> space,
  combining marks and format chars removed, look-alikes folded: Cyrillic, Greek, Armenian, Cherokee, Latin small capitals;
  fullwidth and math letters via NFKD), with any whitespace between words:
  hidden instructions (English, Italian, Spanish, French, German; Chinese checked with all whitespace removed),
  invisible/bidi/filler characters, long encoded strings.
- Encoded text is decoded and scanned again: `%xx`, hex (also `\xNN`), base64 up to 3 levels, rot13.
  Bounded (64 variants, 256 KB decoded); over the budget -> `ENCODED_BLOB` (BLOCK).
- Tool names (snake_case, camelCase, kebab-case, after normalization) that suggest shell, signing or fund movement.
- Parameter names at any depth (properties, items, prefixItems, anyOf/oneOf/allOf, $defs/definitions,
  additionalProperties, patternProperties, not/if/then/else); deeper than 32 levels -> `MALFORMED`.
- Duplicate names after normalization (`get_balance`, `Get_balance`, Cyrillic `а`) -> `DUPLICATE_TOOL` (BLOCK).
- Baseline names are matched after normalization: a look-alike rename is `TOOL_CHANGED`. If in the same scan a pinned
  tool disappears and a new one appears, it is treated as a rename: `TOOL_CHANGED` (BLOCK).
- Bad config (values must be finite and > 0) or malformed pins: `BAD_CONFIG`. Malformed input: `MALFORMED`. Both block.

## Limits (read this)

The phrase filter (hidden instructions, languages, decoding) is **heuristic and will never be complete**:
a new wording, language or encoding can pass it. The real protection is the **pin + `TOOL_CHANGED`**:
any change to a pinned tool, rename included, gives `BLOCK`, and a human must review it before re-pinning.

