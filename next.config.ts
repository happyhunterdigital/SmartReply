import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for App Hosting: the adapter runs `node .next/standalone/server.js`.
  output: "standalone",
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
