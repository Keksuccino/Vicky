import { describe, expect, it } from "vitest";

import nextConfig from "../../../next.config";

describe("WikiJS compatibility redirects", () => {
  it("redirects English WikiJS docs paths to Vicky English docs paths", async () => {
    const redirects = nextConfig.redirects ? await nextConfig.redirects() : [];

    expect(redirects).toContainEqual({
      source: "/en/:path*",
      destination: "/docs/en-US/:path*",
      permanent: true,
    });
  });
});
