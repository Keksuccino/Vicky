import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const createRequest = (headers: Record<string, string>, ip?: string) =>
  ({
    headers: new Headers(headers),
    ip,
  }) as unknown as NextRequest;

describe("client IP detection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the internal client IP header only when explicitly trusted", async () => {
    vi.stubEnv("VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER", "true");
    vi.resetModules();

    const { getClientIp } = await import("@/lib/login-rate-limit");

    expect(getClientIp(createRequest({ "x-vicky-client-ip": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("prefers trusted proxy headers over the custom server socket address", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER", "true");
    vi.resetModules();

    const { getClientIp } = await import("@/lib/login-rate-limit");

    expect(
      getClientIp(
        createRequest({
          "x-forwarded-for": "198.51.100.20, 10.0.0.2",
          "x-vicky-client-ip": "10.0.0.2",
        }),
      ),
    ).toBe("198.51.100.20");
  });
});
