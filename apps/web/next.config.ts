import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@intentguard/core", "@intentguard/signer"],
};

export default nextConfig;
