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
};

export default nextConfig;
