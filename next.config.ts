import type { NextConfig } from "next";

const DEV_CHUNK_LOAD_TIMEOUT_MS = 5 * 60 * 1000;

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {},
  webpack(config, { dev, isServer }) {
    if (dev && !isServer) {
      config.output.chunkLoadTimeout = DEV_CHUNK_LOAD_TIMEOUT_MS;
    }

    return config;
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/docs/:slug*",
          has: [{ type: "query", key: "raw" }],
          destination: "/api/docs/raw/:slug*",
        },
      ],
      afterFiles: [
        {
          source: "/favicon.ico",
          destination: "/api/public/icon/32",
        },
      ],
    };
  },
};

export default nextConfig;
