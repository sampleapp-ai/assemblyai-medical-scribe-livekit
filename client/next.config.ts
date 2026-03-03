import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import { resolve } from "path";

// Load shared .env from the medical-scribe root (two levels up)
loadEnvConfig(resolve(__dirname, "../.."));

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
};

export default nextConfig;
