import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
