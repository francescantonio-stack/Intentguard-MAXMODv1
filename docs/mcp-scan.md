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

- Every string in the whole tool object, after NFKC and basic look-alike folding, with any whitespace between words:
  hidden instructions, invisible/bidi characters, long encoded strings, and short base64 decoded and scanned again.
- Tool names (snake_case, camelCase, kebab-case) that suggest shell, signing or fund movement; top-level params asking for secrets.
- Bad config (values must be finite and > 0) or malformed pins: `BAD_CONFIG`. Malformed input: `MALFORMED`. Both block.
