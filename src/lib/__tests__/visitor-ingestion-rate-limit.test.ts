import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/client-ip-policy";
import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";

const createRequest = (ip: string): NextRequest => ({ headers: new Headers(), ip }) as unknown as NextRequest;
const createHeaderRequest = (headers: Record<string, string>): NextRequest => ({ headers: new Headers(headers) }) as unknown as NextRequest;
const createTrustedProxyRequest = (clientIp: string): NextRequest => createHeaderRequest({ "x-forwarded-for": clientIp, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "analytics-test-token", [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" });

describe("visitor analytics admission limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enforces deterministic per-client, global, and concurrency limits", async () => {
    vi.stubEnv("VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS", "2");
    vi.stubEnv("VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS", "4");
    vi.stubEnv("VISITOR_ANALYTICS_RATE_WINDOW_SECONDS", "10");
    vi.stubEnv("VISITOR_ANALYTICS_CLIENT_MAX_CONCURRENCY", "1");
    vi.stubEnv("VISITOR_ANALYTICS_GLOBAL_MAX_CONCURRENCY", "2");
    vi.resetModules();

    const { acquireVisitorIngestionPermit } = await import("@/lib/visitor-ingestion-rate-limit");
    const clientA = createRequest("203.0.113.1");
    const clientB = createRequest("203.0.113.2");
    const first = acquireVisitorIngestionPermit(clientA, 1_000);
    const concurrent = acquireVisitorIngestionPermit(clientA, 1_000);
    const parallelClient = acquireVisitorIngestionPermit(clientB, 1_000);
    const globallyConcurrent = acquireVisitorIngestionPermit(createRequest("203.0.113.3"), 1_000);

    expect(first.allowed).toBe(true);
    expect(concurrent).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(parallelClient.allowed).toBe(true);
    expect(globallyConcurrent).toEqual({ allowed: false, retryAfterSeconds: 1 });
    if (first.allowed) {
      first.release();
    }
    if (parallelClient.allowed) {
      parallelClient.release();
    }

    const second = acquireVisitorIngestionPermit(clientA, 1_000);
    expect(second.allowed).toBe(true);
    if (second.allowed) {
      second.release();
    }
    expect(acquireVisitorIngestionPermit(clientA, 1_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });

    const fourth = acquireVisitorIngestionPermit(createRequest("203.0.113.3"), 1_000);
    expect(fourth.allowed).toBe(true);
    if (fourth.allowed) {
      fourth.release();
    }
    expect(acquireVisitorIngestionPermit(createRequest("203.0.113.4"), 1_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });

    const afterWindow = acquireVisitorIngestionPermit(clientA, 11_000);
    expect(afterWindow.allowed).toBe(true);
    if (afterWindow.allowed) {
      afterWindow.release();
    }
  });

  it("keys analytics admission by trusted ingress client instead of the shared proxy", async () => {
    vi.stubEnv("VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS", "1");
    vi.stubEnv("VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS", "100");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "analytics-test-token");
    vi.resetModules();
    const { acquireVisitorIngestionPermit } = await import("@/lib/visitor-ingestion-rate-limit");

    const firstClient = acquireVisitorIngestionPermit(createTrustedProxyRequest("198.51.100.20"), 2_000);
    expect(firstClient.allowed).toBe(true);
    if (firstClient.allowed) {
      firstClient.release();
    }
    const secondClient = acquireVisitorIngestionPermit(createTrustedProxyRequest("198.51.100.21"), 2_000);
    expect(secondClient.allowed).toBe(true);
    if (secondClient.allowed) {
      secondClient.release();
    }
    expect(acquireVisitorIngestionPermit(createTrustedProxyRequest("198.51.100.20"), 2_000).allowed).toBe(false);
  });

  it("uses global-only analytics admission when the client address is unknown", async () => {
    vi.stubEnv("VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS", "1");
    vi.stubEnv("VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS", "3");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "false");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "");
    vi.resetModules();
    const { acquireVisitorIngestionPermit } = await import("@/lib/visitor-ingestion-rate-limit");

    for (const spoofedIp of ["198.51.100.20", "198.51.100.21", "198.51.100.22"]) {
      const permit = acquireVisitorIngestionPermit(createHeaderRequest({ "x-forwarded-for": spoofedIp, [INTERNAL_CLIENT_IP_HEADER]: spoofedIp }), 3_000);
      expect(permit.allowed).toBe(true);
      if (permit.allowed) {
        permit.release();
      }
    }
    expect(acquireVisitorIngestionPermit(createHeaderRequest({}), 3_000).allowed).toBe(false);
  });
});
