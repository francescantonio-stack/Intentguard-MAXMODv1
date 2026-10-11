import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Vercel Root Directory is apps/web; workspace packages live two levels up.
const monorepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@intentguard/core", "@intentguard/signer"],
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  // MCP and older links use /?intent=…; the planner lives at /app.
  async redirects() {
    return [
      {
        source: "/",
        has: [{ type: "query", key: "intent", value: "(?<intent>.*)" }],
        destination: "/app?intent=:intent",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
