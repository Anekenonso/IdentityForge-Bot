import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The SDK is ESM-only and pulls in node:crypto; keep it out of the optimizer
  // so the node runtime is used for every route.
  serverExternalPackages: ["@mysten-incubation/memwal", "@noble/hashes"],
};

export default nextConfig;
