import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";
import {
  getClientIp,
  INTERNAL_CLIENT_IP_HEADER,
  normalizeClientIp,
  resolveClientIp,
  resolveTrustedForwardedClientIp,
  type ClientIpRequest,
} from "@/lib/client-ip-policy";

const INTERNAL_TOKEN = "test-process-token";

const createRequest = (headers: Record<string, string> = {}, ip?: string): ClientIpRequest => ({ headers: new Headers(headers), ip });

const createIncludedServerRequest = (peerIp: string, forwardedHeaders: Record<string, string> = {}, frameworkIp?: string): ClientIpRequest => createRequest({ ...forwardedHeaders, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: INTERNAL_TOKEN, [INTERNAL_CLIENT_IP_HEADER]: peerIp }, frameworkIp);

describe("client IP policy", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "false");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", INTERNAL_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("canonicalizes exact IPv4, IPv6, and IPv4-mapped IPv6 values", () => {
    expect(normalizeClientIp("203.0.113.10")).toBe("203.0.113.10");
    expect(normalizeClientIp("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    expect(normalizeClientIp("::ffff:192.0.2.128")).toBe("192.0.2.128");
    expect(normalizeClientIp("::ffff:c000:0280")).toBe("192.0.2.128");
  });

  it.each(["", " 203.0.113.10", "203.0.113.10 ", "203.0.113.10:443", "[2001:db8::1]", "[2001:db8::1]:443", "198.51.100.1, 10.0.0.2", "999.0.0.1", "192.168.001.1", "fe80::1%lo0", "not-an-ip"])("rejects non-exact IP input %j", (value) => {
    expect(normalizeClientIp(value)).toBeNull();
  });

  it("ignores spoofed forwarded and private headers without their trust boundaries", () => {
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "different-process-token");
    const request = createRequest({ "x-forwarded-for": "198.51.100.20", [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "attacker-token", [INTERNAL_CLIENT_IP_HEADER]: "203.0.113.10" });

    expect(resolveClientIp(request)).toBeNull();
    expect(getClientIp(request)).toBe("unknown");
  });

  it("cannot be tricked into trusting forwarded headers in plain Next without an authenticated peer", () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "");

    expect(resolveClientIp(createRequest({ "x-forwarded-for": "198.51.100.20", [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" }))).toBeNull();
  });

  it("uses a framework direct IP without allowing untrusted forwarded data to override it", () => {
    expect(resolveClientIp(createRequest({ "x-forwarded-for": "198.51.100.20" }, "203.0.113.10"))).toBe("203.0.113.10");
  });

  it("uses only the token-authenticated included-server socket address for direct deployments", () => {
    expect(resolveClientIp(createIncludedServerRequest("::ffff:203.0.113.10"))).toBe("203.0.113.10");
    expect(resolveClientIp(createIncludedServerRequest("bad-ip"))).toBeNull();
  });

  it("prefers a trusted ingress client over authenticated socket and framework peer addresses", () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    const request = createIncludedServerRequest("10.0.0.2", { "x-forwarded-for": "198.51.100.20" }, "192.0.2.44");

    expect(resolveClientIp(request)).toBe("198.51.100.20");
  });

  it("never lets forwarded data from an unlisted peer override authenticated direct context", () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.3");
    const request = createIncludedServerRequest("10.0.0.2", { "x-forwarded-for": "198.51.100.20" }, "192.0.2.44");

    expect(resolveClientIp(request)).toBe("10.0.0.2");
  });

  it("supports an allowlisted framework direct peer when a runtime supplies one", () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "2001:db8::10");

    expect(resolveClientIp(createRequest({ "x-real-ip": "2001:db8::20" }, "2001:0db8:0:0::10"))).toBe("2001:db8::20");
  });

  it("fails closed for absent or invalid trusted-proxy allowlists", () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    const request = createIncludedServerRequest("10.0.0.2", { "x-forwarded-for": "198.51.100.20" });

    expect(resolveClientIp(request)).toBe("10.0.0.2");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2,not-an-ip");
    expect(resolveClientIp(request)).toBe("10.0.0.2");
  });

  it("matches mapped socket peers to canonical IPv4 allowlist entries", () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "127.0.0.1");

    expect(resolveClientIp(createIncludedServerRequest("::ffff:127.0.0.1", { "x-forwarded-for": "::ffff:198.51.100.20" }))).toBe("198.51.100.20");
  });

  it("accepts one trusted overwrite value and requires two supplied headers to agree", () => {
    expect(resolveTrustedForwardedClientIp(new Headers({ "x-forwarded-for": "198.51.100.20" }), true)).toBe("198.51.100.20");
    expect(resolveTrustedForwardedClientIp(new Headers({ "x-real-ip": "2001:db8::20" }), true)).toBe("2001:db8::20");
    expect(resolveTrustedForwardedClientIp(new Headers({ "x-forwarded-for": "::ffff:198.51.100.20", "x-real-ip": "198.51.100.20" }), true)).toBe("198.51.100.20");
    expect(resolveTrustedForwardedClientIp(new Headers({ "x-forwarded-for": "198.51.100.20", "x-real-ip": "198.51.100.21" }), true)).toBeNull();
  });

  it("rejects malformed and multi-hop forwarded values instead of guessing a hop", () => {
    const internalRequest = createIncludedServerRequest("10.0.0.2", { "x-forwarded-for": "198.51.100.20, 10.0.0.2" });
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");

    expect(resolveClientIp(internalRequest)).toBe("10.0.0.2");
    expect(resolveTrustedForwardedClientIp(new Headers({ "x-forwarded-for": "198.51.100.20", "x-real-ip": "garbage" }), true)).toBeNull();
  });
});
