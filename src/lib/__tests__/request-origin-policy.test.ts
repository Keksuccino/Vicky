import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER,
  INTERNAL_REQUEST_HOST_HEADER,
  INTERNAL_REQUEST_PROTOCOL_HEADER,
  normalizeHttpAuthority,
  normalizeHttpOrigin,
  resolveRequestOrigin,
} from "@/lib/request-origin-policy.mjs";

const originalEnvironment = {
  VICKY_DIRECT_REQUEST_PROTOCOL: process.env.VICKY_DIRECT_REQUEST_PROTOCOL,
  VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN: process.env.VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN,
  VICKY_TRUST_PROXY_ORIGIN_HEADERS: process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS,
};

const restoreEnvironmentValue = (name: keyof typeof originalEnvironment): void => {
  const value = originalEnvironment[name];
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

const resolve = (headers: Headers, customDomain = ""): string | null => resolveRequestOrigin({ customDomain, headers });

describe("request origin trust policy", () => {
  beforeEach(() => {
    delete process.env.VICKY_DIRECT_REQUEST_PROTOCOL;
    delete process.env.VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN;
    delete process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS;
  });

  afterEach(() => {
    restoreEnvironmentValue("VICKY_DIRECT_REQUEST_PROTOCOL");
    restoreEnvironmentValue("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN");
    restoreEnvironmentValue("VICKY_TRUST_PROXY_ORIGIN_HEADERS");
  });

  it("ignores spoofed proxy and Forwarded headers unless origin-header trust is explicitly enabled", () => {
    const headers = new Headers({
      forwarded: "for=192.0.2.1;host=forwarded.attacker;proto=http",
      host: "docs.example.com",
      "x-forwarded-host": "proxy.attacker:8080",
      "x-forwarded-proto": "http",
    });

    expect(resolve(headers)).toBe("https://docs.example.com");
  });

  it("uses one complete validated proxy pair when the deployment boundary explicitly trusts it", () => {
    process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = "true";
    const headers = new Headers({ host: "app.internal:3000", "x-forwarded-host": "Docs.Example.com:8443", "x-forwarded-proto": "HTTPS" });

    expect(resolve(headers)).toBe("https://docs.example.com:8443");
  });

  it.each([
    ["multiple forwarded hosts", "docs.example.com, attacker.example", "https"],
    ["multiple forwarded protocols", "docs.example.com", "https,http"],
    ["invalid protocol", "docs.example.com", "javascript"],
    ["userinfo", "user@docs.example.com", "https"],
    ["path", "docs.example.com/path", "https"],
    ["invalid port", "docs.example.com:65536", "https"],
    ["control character", "docs.example.com\u007f", "https"],
  ])("ignores a malformed trusted pair containing %s", (_label, forwardedHost, forwardedProtocol) => {
    process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = "true";
    const headers = new Headers({ host: "direct.example.com", "x-forwarded-host": forwardedHost, "x-forwarded-proto": forwardedProtocol });

    expect(resolve(headers)).toBe("https://direct.example.com");
  });

  it("requires both forwarded values instead of mixing proxy and direct authority data", () => {
    process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = "true";

    expect(resolve(new Headers({ host: "direct.example.com", "x-forwarded-proto": "http" }))).toBe("https://direct.example.com");
    expect(resolve(new Headers({ host: "direct.example.com", "x-forwarded-host": "public.example.com" }))).toBe("https://direct.example.com");
    expect(resolve(new Headers({ forwarded: "for=192.0.2.1;host=public.example.com;proto=http", host: "direct.example.com" }))).toBe("https://direct.example.com");
  });

  it("always prefers the normalized configured custom domain for canonical public URLs", () => {
    process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = "true";
    const headers = new Headers({ host: "direct.example.com", "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "http" });

    expect(resolve(headers, "HTTPS://Docs.Example.com./")).toBe("https://docs.example.com");
  });

  it("supports validated direct DNS, IPv4, IPv6, localhost, and development ports", () => {
    expect(resolve(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(resolve(new Headers({ host: "127.0.0.1:8080" }))).toBe("http://127.0.0.1:8080");
    expect(resolve(new Headers({ host: "[::1]:3000" }))).toBe("http://[::1]:3000");
    expect(resolve(new Headers({ host: "[2001:db8::1]:8443" }))).toBe("https://[2001:db8::1]:8443");
    expect(resolve(new Headers({ host: "Docs.Example.com.:8443" }))).toBe("https://docs.example.com:8443");
  });

  it("uses an explicitly configured direct protocol for plain Next deployments", () => {
    process.env.VICKY_DIRECT_REQUEST_PROTOCOL = "http";
    expect(resolve(new Headers({ host: "docs.example.com:8080" }))).toBe("http://docs.example.com:8080");

    process.env.VICKY_DIRECT_REQUEST_PROTOCOL = "file";
    expect(resolve(new Headers({ host: "docs.example.com:8080" }))).toBe("https://docs.example.com:8080");
  });

  it("accepts included-server direct context only with its matching per-process token", () => {
    process.env.VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN = "server-secret";
    const headers = new Headers({
      host: "fallback.example.com",
      [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "server-secret",
      [INTERNAL_REQUEST_HOST_HEADER]: "192.168.1.20:3000",
      [INTERNAL_REQUEST_PROTOCOL_HEADER]: "http",
    });

    expect(resolve(headers)).toBe("http://192.168.1.20:3000");
    headers.set(INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER, "client-spoof");
    expect(resolve(headers)).toBe("https://fallback.example.com");
  });

  it.each([
    "user@example.com",
    "example.com/path",
    "example.com?query",
    "example.com#fragment",
    "example.com,attacker.example",
    "example.com:0",
    "example.com:01",
    "example.com:65536",
    "[::1",
    "::1",
    "127.1",
    "0x7f.1",
    "001.002.003.004",
    "-bad.example",
    "bad-.example",
  ])("rejects unsafe or ambiguous direct authority %s", (authority) => {
    expect(normalizeHttpAuthority(authority)).toBeNull();
    expect(resolve(new Headers({ host: authority }))).toBeNull();
  });

  it("normalizes only path-free HTTP(S) Origin values", () => {
    expect(normalizeHttpAuthority("example.com\r\nattacker.example")).toBeNull();
    expect(normalizeHttpOrigin("HTTPS://Docs.Example.com:443")).toBe("https://docs.example.com");
    expect(normalizeHttpOrigin("https://docs.example.com/path")).toBeNull();
    expect(normalizeHttpOrigin("https://user@docs.example.com")).toBeNull();
    expect(normalizeHttpOrigin("null")).toBeNull();
    expect(normalizeHttpOrigin("file://docs.example.com")).toBeNull();
  });
});
