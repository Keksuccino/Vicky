// Provides the global AsyncLocalStorage that the edge runtime gives the compiled middleware. It must
// be evaluated before any Next module creates its request-scoped storage.
import "next/dist/server/node-environment-baseline";
import { adapter } from "next/dist/server/web/adapter";
import { describe, expect, it } from "vitest";

import { middleware } from "../../../middleware";

// Headers a visitor, a proxy, or an attacker may send. None of them may reach the Location header.
const FORWARDED_HEADERS = { host: "docs.example.com", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" };

/**
 * Runs the middleware through Next's edge adapter, which wraps the compiled middleware in
 * production, with the absolute URL a Next server builds from its own listener address. The
 * adapter parses and rewrites the Location header, so calling `middleware()` directly cannot show
 * what a visitor receives. `next/dist/server/web/adapter` is internal to Next: when an upgrade moves
 * it, point this import at the module that `next/dist/build/templates/middleware.js` imports.
 */
const serve = async (url: string, headers: Record<string, string> = FORWARDED_HEADERS): Promise<Response> => {
  const { response } = await adapter({
    handler: middleware,
    page: "/middleware",
    request: { headers, method: "GET", nextConfig: { basePath: "", trailingSlash: false }, signal: new AbortController().signal, url },
  });
  return response;
};

describe("middleware as served by Next", () => {
  it.each(["http://0.0.0.0:3000", "http://127.0.0.1:3417", "https://[::1]:8443"])("redirects unauthenticated pages behind the listener %s to the login page on the visitor's origin", async (listenerOrigin) => {
    const targets = {
      "/admin": "/admin/login?next=%2Fadmin",
      "/admin/settings?tab=domain": "/admin/login?next=%2Fadmin%2Fsettings%3Ftab%3Ddomain",
      "/editor": "/admin/login?next=%2Feditor",
    };

    for (const [target, location] of Object.entries(targets)) {
      const response = await serve(`${listenerOrigin}${target}`);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(location);
    }
  });

  it("answers unauthenticated admin API requests without redirecting", async () => {
    const response = await serve("http://0.0.0.0:3000/api/admin/settings");

    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets the login page through", async () => {
    const response = await serve("http://0.0.0.0:3000/admin/login?next=%2Fadmin");

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });
});
