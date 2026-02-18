import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
