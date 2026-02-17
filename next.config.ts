import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    return [
      {
        source: "/favicon.ico",
        destination: "/api/public/icon/32",
      },
    ];
  },
};

export default nextConfig;
