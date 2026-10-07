#!/usr/bin/env -S npx tsx
// IntentGuard MCP server (stdio). Gives any AI agent read + propose access to a user's IntentGuard account.
// It holds no keys: executing a plan always needs the user's passkey in the reference app.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { envFromProcess, proposePlan, recentDecisions, status, type ToolOutput } from "./tools";

const env = envFromProcess();
const server = new McpServer({ name: "intentguard", version: "0.1.0" });
const reply = (o: ToolOutput) => ({ content: [{ type: "text" as const, text: o.text }], isError: !o.ok });

server.registerTool(
  "intentguard_status",
  {
    title: "IntentGuard account status",
    description: "The user's derived EVM address, weekly allowance left (NEAR policy and Monad PlanExecutor), passkey registration and balances on Base Sepolia / Monad testnet.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => reply(await status(env)),
);

server.registerTool(
  "intentguard_propose_plan",
  {
    title: "Propose a plan for passkey approval",
    description:
      "Turn a request (e.g. 'Bridge 2 USDC from Base to Monad, swap half to MON, deposit the rest in the vault') into a checked plan and an approval link for the user. You cannot execute it yourself: the user approves with their passkey. Plans outside the user's policy are blocked with the reason.",
    inputSchema: {
      command: z.string().optional().describe("The request in natural language (Italian or English)"),
      intent: z.record(z.string(), z.unknown()).optional().describe("Optional structured intent v1 (version, actions, limits) instead of `command`"),
    },
  },
  async (args) => reply(await proposePlan(env, args)),
);

server.registerTool(
  "intentguard_recent_decisions",
  {
    title: "Guard log",
    description: "Latest decisions of the on-chain policy (allowed and rejected requests, with reasons).",
    inputSchema: { limit: z.number().int().min(1).max(25).optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) => reply(await recentDecisions(env, limit)),
);

await server.connect(new StdioServerTransport());
